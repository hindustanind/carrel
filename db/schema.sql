-- Carrel: LPU library seat finder. PostgreSQL 14+.
-- The database is the source of truth for fairness: double bookings are impossible by constraint,
-- and every timer is a server timestamp (never a client clock).

create extension if not exists pgcrypto;

create table if not exists settings (
  key   text primary key,
  value text not null
);
insert into settings(key, value) values ('hold_seconds', '600'), ('break_seconds', '1200'), ('time_scale', '1')
on conflict (key) do nothing;

create table if not exists floors (
  id    smallint primary key,
  name  text not null,
  meta  text not null default ''
);

create table if not exists seats (
  id        text primary key,               -- e.g. F2-T07-S3
  floor_id  smallint not null references floors(id),
  zone      char(1)  not null check (zone in ('T','C','L')),   -- reading Table, window Carrel, Lounge
  label     text not null,                  -- e.g. "Table 07 · Seat 3"
  x         real not null,
  y         real not null,
  face      smallint not null,
  amenities text[] not null default '{}',
  active    boolean not null default true
);
create index if not exists seats_floor on seats(floor_id);

create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  reg_no     text unique not null check (reg_no ~ '^[0-9]{8}$'),
  name       text not null,
  role       text not null default 'student' check (role in ('student','admin')),
  pass_hash  text not null,
  created_at timestamptz not null default now()
);

create table if not exists bookings (
  id               bigserial primary key,
  seat_id          text not null references seats(id),
  user_id          uuid not null references users(id),
  status           text not null check (status in ('held','occupied','break','released','completed','cancelled')),
  created_at       timestamptz not null default now(),
  checked_in_at    timestamptz,
  break_started_at timestamptz,
  expires_at       timestamptz,                -- set while held or on break
  ended_at         timestamptz,
  end_reason       text,
  duration_s       integer not null default 7200
);
alter table bookings add column if not exists duration_s integer not null default 7200;
-- THE fairness guarantee: at most one live booking per seat, and one per student.
create unique index if not exists one_live_per_seat on bookings(seat_id) where status in ('held','occupied','break');
create unique index if not exists one_live_per_user on bookings(user_id) where status in ('held','occupied','break');
create index if not exists bookings_expiry on bookings(expires_at) where status in ('held','break');

create table if not exists seat_events (
  id         bigserial primary key,
  seat_id    text not null,
  user_id    uuid,
  booking_id bigint,
  kind       text not null,   -- held | checked_in | break | resumed | completed | cancelled | released_no_checkin | released_break_timeout | admin_release
  dur_s      integer,         -- for 'resumed': how long the break lasted
  at         timestamptz not null default now()
);
alter table seat_events add column if not exists dur_s integer;
create index if not exists seat_events_at on seat_events(at);
create index if not exists seat_events_seat on seat_events(seat_id, at);

-- live status per seat
create or replace view seat_status as
select s.id, s.floor_id, s.zone, s.label, s.x, s.y, s.face, s.amenities,
       coalesce(b.status, 'free') as status, b.user_id, b.expires_at, b.id as booking_id
from seats s
left join bookings b on b.seat_id = s.id and b.status in ('held','occupied','break')
where s.active;

create or replace function setting_seconds(k text) returns double precision language sql stable as $$
  select (select value::double precision from settings where key = k)
       / greatest((select value::double precision from settings where key = 'time_scale'), 1)
$$;

-- realtime: every booking change is published to listeners (the API fans it out over SSE)
create or replace function notify_booking() returns trigger language plpgsql as $$
begin
  perform pg_notify('seat_changes', json_build_object(
    'seat_id', new.seat_id,
    'status', case when new.status in ('held','occupied','break') then new.status else 'free' end,
    'expires_at', new.expires_at,
    'at', extract(epoch from clock_timestamp()) * 1000)::text);
  return new;
end $$;
drop trigger if exists bookings_notify on bookings;
create trigger bookings_notify after insert or update of status, expires_at on bookings
for each row execute function notify_booking();

-- release holds that were never checked in and breaks that ran out. Safe to call any time, from anywhere.
create or replace function release_expired(p_seat text default null) returns integer language plpgsql as $$
declare n integer;
begin
  with gone as (
    update bookings b
       set status = 'released', ended_at = now(),
           end_reason = case b.status when 'held' then 'no_checkin' else 'break_timeout' end
     where b.status in ('held','break') and b.expires_at < now()
       and (p_seat is null or b.seat_id = p_seat)
    returning b.id, b.seat_id, b.user_id, b.end_reason
  )
  insert into seat_events(seat_id, user_id, booking_id, kind)
  select seat_id, user_id, id, 'released_' || end_reason from gone;
  get diagnostics n = row_count;
  return n;
end $$;

drop function if exists book_seat(uuid, text);
create or replace function book_seat(p_user uuid, p_seat text, p_duration integer default 7200) returns bookings language plpgsql as $$
declare b bookings; dur integer;
begin
  if not exists (select 1 from seats where id = p_seat and active) then
    raise exception 'NO_SUCH_SEAT' using errcode = 'P0002';
  end if;
  dur := greatest(1800, least(14400, coalesce(p_duration, 7200)));
  perform release_expired(p_seat);
  -- a student with an expired hold elsewhere should not be blocked by it
  perform release_expired(s.seat_id) from bookings s where s.user_id = p_user and s.status in ('held','break');
  begin
    insert into bookings(seat_id, user_id, status, expires_at, duration_s)
    values (p_seat, p_user, 'held', now() + make_interval(secs => setting_seconds('hold_seconds')), dur)
    returning * into b;
  exception when unique_violation then
    if exists (select 1 from bookings where user_id = p_user and status in ('held','occupied','break')) then
      raise exception 'YOU_ALREADY_HAVE_A_SEAT' using errcode = 'P0001';
    end if;
    raise exception 'SEAT_TAKEN' using errcode = 'P0001';
  end;
  insert into seat_events(seat_id, user_id, booking_id, kind) values (p_seat, p_user, b.id, 'held');
  return b;
end $$;

-- check in (from held) or resume (from break). Requires that this student holds THIS seat.
create or replace function check_in(p_user uuid, p_seat text) returns bookings language plpgsql as $$
declare b bookings; prev text; brk timestamptz;
begin
  perform release_expired(p_seat);
  select * into b from bookings
   where seat_id = p_seat and user_id = p_user and status in ('held','break','occupied')
   for update;
  if not found then
    raise exception 'NOT_YOUR_SEAT' using errcode = 'P0001';
  end if;
  if b.status = 'occupied' then return b; end if;
  prev := b.status; brk := b.break_started_at;
  update bookings set status = 'occupied', expires_at = null, break_started_at = null,
         checked_in_at = coalesce(checked_in_at, now())
   where id = b.id returning * into b;
  insert into seat_events(seat_id, user_id, booking_id, kind, dur_s)
  values (p_seat, p_user, b.id, case prev when 'held' then 'checked_in' else 'resumed' end,
          case when prev = 'break' then extract(epoch from now() - brk)::int end);
  return b;
end $$;

create or replace function start_break(p_user uuid) returns bookings language plpgsql as $$
declare b bookings;
begin
  update bookings set status = 'break', break_started_at = now(),
         expires_at = now() + make_interval(secs => setting_seconds('break_seconds'))
   where user_id = p_user and status = 'occupied'
  returning * into b;
  if not found then raise exception 'NOT_CHECKED_IN' using errcode = 'P0001'; end if;
  insert into seat_events(seat_id, user_id, booking_id, kind) values (b.seat_id, p_user, b.id, 'break');
  return b;
end $$;

create or replace function end_session(p_user uuid) returns bookings language plpgsql as $$
declare b bookings;
begin
  perform release_expired(s.seat_id) from bookings s where s.user_id = p_user and s.status in ('held','break');
  update bookings set status = case status when 'held' then 'cancelled' else 'completed' end,
         ended_at = now(), end_reason = 'left', expires_at = null
   where user_id = p_user and status in ('held','occupied','break')
  returning * into b;
  if not found then raise exception 'NO_ACTIVE_SEAT' using errcode = 'P0001'; end if;
  insert into seat_events(seat_id, user_id, booking_id, kind) values (b.seat_id, p_user, b.id, b.status);
  return b;
end $$;

create or replace function admin_release(p_seat text) returns integer language plpgsql as $$
declare n integer;
begin
  with gone as (
    update bookings set status = 'released', ended_at = now(), end_reason = 'admin'
     where seat_id = p_seat and status in ('held','occupied','break')
    returning id, seat_id, user_id
  )
  insert into seat_events(seat_id, user_id, booking_id, kind) select seat_id, user_id, id, 'admin_release' from gone;
  get diagnostics n = row_count;
  return n;
end $$;
