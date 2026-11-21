// API tests against a real PostgreSQL (TEST_DATABASE_URL, default: carrel_test in the local docker container).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import http from 'node:http';
import { createApp } from '../server/app.js';
import { seed } from '../db/seed.js';
import { signSession, qrSig } from '../server/auth.js';

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://carrel:carrel@localhost:5544/carrel';
const TEST_URL = process.env.TEST_DATABASE_URL || ADMIN_URL.replace(/\/[^/]+$/, '/carrel_test');
const S = 'test-session-secret', Q = 'test-qr-secret';
let app, base, db;
const quiet = { error() {}, log() {} };

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
  await admin.query('drop database if exists carrel_test with (force)'); await admin.query('create database carrel_test'); await admin.end();
  db = new pg.Pool({ connectionString: TEST_URL, max: 10 });
  await db.query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await seed(db, { demo: true });
  app = createApp({ databaseUrl: TEST_URL, sessionSecret: S, qrSecret: Q, publicOrigin: 'http://test.local', staticDir: null, sweepMs: 150, log: quiet });
  base = `http://localhost:${await app.start(0)}`;
});
after(async () => { await app.stop(); await db.end(); });
beforeEach(async () => {
  await db.query('truncate bookings, seat_events restart identity');
  await db.query(`update settings set value = case key when 'hold_seconds' then '600' when 'break_seconds' then '1200' else '1' end`);
});

const users = {};
async function user(reg, role = 'student') {
  if (!users[reg]) {
    const { rows: [u] } = await db.query(`insert into users(reg_no,name,role,pass_hash) values($1,$2,$3,'scrypt$x$y')
      on conflict (reg_no) do update set role = $3 returning *`, [reg, 'T ' + reg, role]);
    users[reg] = { ...u, token: signSession(S, u) };
  }
  return users[reg];
}
// keep-alive pool so 300 concurrent requests are queued like a real load balancer would (macOS caps the listen backlog at 128)
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
function raw(method, path, u, data) {
  return new Promise((resolve, reject) => {
    const payload = data ? JSON.stringify(data) : '';
    const r = http.request(base + path, { method, agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
      ...(u ? { authorization: `Bearer ${u.token}` } : {}) } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject); r.end(payload);
  });
}
async function call(method, path, u, data) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(u ? { authorization: `Bearer ${u.token}` } : {}) },
    body: data ? JSON.stringify(data) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const statusOf = async seat => (await db.query('select status from seat_status where id = $1', [seat])).rows[0].status;
const SEAT = 'F2-T07-S3', SEAT2 = 'F2-T07-S4';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('seed: 3 floors × 129 seats with stable ids', async () => {
  const { rows: [r] } = await db.query('select count(*)::int n, count(distinct floor_id)::int f from seats');
  assert.equal(r.n, 387); assert.equal(r.f, 3);
  const { rows } = await db.query(`select id from seats where id in ('F1-T01-S1','F2-C9','F3-L6-S4')`);
  assert.equal(rows.length, 3);
});

test('booking holds a seat; a second student gets SEAT_TAKEN', async () => {
  const a = await user('20000001'), b = await user('20000002');
  const r1 = await call('POST', '/api/book', a, { seat_id: SEAT });
  assert.equal(r1.status, 201); assert.equal(r1.body.booking.status, 'held');
  assert.ok(new Date(r1.body.booking.expires_at) - Date.now() > 590000, 'hold lasts ~10 minutes');
  const r2 = await call('POST', '/api/book', b, { seat_id: SEAT });
  assert.equal(r2.status, 409); assert.equal(r2.body.error, 'SEAT_TAKEN');
});

test('no double bookings: 300 students race for one seat, exactly one wins', async () => {
  const racers = await Promise.all(Array.from({ length: 300 }, (_, i) => user(String(30000000 + i))));
  const results = await Promise.all(racers.map(u => raw('POST', '/api/book', u, { seat_id: SEAT })));
  const codes = results.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
  assert.equal(codes[201], 1, JSON.stringify(codes));
  assert.equal(codes[409], 299, JSON.stringify(codes));
  const { rows: [d] } = await db.query(`select count(*)::int n from bookings where seat_id = $1 and status in ('held','occupied','break')`, [SEAT]);
  assert.equal(d.n, 1);
});

test('one live seat per student', async () => {
  const a = await user('20000003');
  assert.equal((await call('POST', '/api/book', a, { seat_id: SEAT })).status, 201);
  const r = await call('POST', '/api/book', a, { seat_id: SEAT2 });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'YOU_ALREADY_HAVE_A_SEAT');
});

test('a hold that is never checked in is auto-released', async () => {
  await db.query(`update settings set value = '1' where key = 'hold_seconds'`);
  const a = await user('20000004');
  await call('POST', '/api/book', a, { seat_id: SEAT });
  assert.equal(await statusOf(SEAT), 'held');
  await sleep(1500);
  assert.equal(await statusOf(SEAT), 'free', 'sweeper released it');
  const { rows } = await db.query(`select kind from seat_events where seat_id = $1 order by id`, [SEAT]);
  assert.deepEqual(rows.map(r => r.kind), ['held', 'released_no_checkin']);
  // and the student can book again straight away
  assert.equal((await call('POST', '/api/book', a, { seat_id: SEAT2 })).status, 201);
});

test('QR check-in: forged code rejected, valid code only works for the holder', async () => {
  const a = await user('20000005'), b = await user('20000006');
  await call('POST', '/api/book', a, { seat_id: SEAT });
  const forged = await call('POST', '/api/checkin', a, { seat_id: SEAT, k: 'AAAAAAAAAAAAAAAA' });
  assert.equal(forged.status, 400); assert.equal(forged.body.error, 'BAD_QR');
  const otherSeatCode = await call('POST', '/api/checkin', a, { seat_id: SEAT, k: qrSig(Q, SEAT2) });
  assert.equal(otherSeatCode.status, 400, 'a code from another desk does not work');
  const stranger = await call('POST', '/api/checkin', b, { seat_id: SEAT, k: qrSig(Q, SEAT) });
  assert.equal(stranger.status, 403); assert.equal(stranger.body.error, 'NOT_YOUR_SEAT');
  const ok = await call('POST', '/api/checkin', a, { seat_id: SEAT, k: qrSig(Q, SEAT) });
  assert.equal(ok.status, 200); assert.equal(ok.body.booking.status, 'occupied');
  assert.equal(ok.body.booking.expires_at, null, 'no timer while checked in');
});

test('walk-up: forged code books nothing; a real desk code holds and checks in at once', async () => {
  const a = await user('20000014');
  const bad = await call('POST', '/api/walkin', a, { seat_id: SEAT, k: 'AAAAAAAAAAAAAAAA' });
  assert.equal(bad.status, 400);
  assert.equal(await statusOf(SEAT), 'free', 'nothing was held');
  const ok = await call('POST', '/api/walkin', a, { seat_id: SEAT, k: qrSig(Q, SEAT) });
  assert.equal(ok.status, 200); assert.equal(ok.body.booking.status, 'occupied');
  const b = await user('20000015');
  assert.equal((await call('POST', '/api/walkin', b, { seat_id: SEAT, k: qrSig(Q, SEAT) })).status, 409, 'taken desk cannot be walked into');
});

test('break: 20-minute timer, resume by re-scanning, or auto-release', async () => {
  const a = await user('20000007');
  await call('POST', '/api/book', a, { seat_id: SEAT });
  assert.equal((await call('POST', '/api/break', a)).status, 409, 'cannot break before checking in');
  await call('POST', '/api/checkin', a, { seat_id: SEAT, k: qrSig(Q, SEAT) });
  const br = await call('POST', '/api/break', a);
  assert.equal(br.body.booking.status, 'break');
  const left = new Date(br.body.booking.expires_at) - Date.now();
  assert.ok(left > 1190000 && left <= 1200500, `break lasts 20 min, got ${left}`);
  // resume in time
  const back = await call('POST', '/api/checkin', a, { seat_id: SEAT, k: qrSig(Q, SEAT) });
  assert.equal(back.body.booking.status, 'occupied');
  const { rows: [ev] } = await db.query(`select dur_s from seat_events where kind = 'resumed'`);
  assert.ok(ev.dur_s >= 0);
  // now a break that runs out
  await db.query(`update settings set value = '1' where key = 'break_seconds'`);
  await call('POST', '/api/break', a);
  await sleep(1500);
  assert.equal(await statusOf(SEAT), 'free');
  const { rows: [last] } = await db.query(`select kind from seat_events order by id desc limit 1`);
  assert.equal(last.kind, 'released_break_timeout');
  assert.equal((await call('POST', '/api/checkin', a, { seat_id: SEAT, k: qrSig(Q, SEAT) })).status, 403, 'too late to resume');
});

test('time scale shortens every timer for live demos', async () => {
  await db.query(`update settings set value = '20' where key = 'time_scale'`);
  const a = await user('20000008');
  const r = await call('POST', '/api/book', a, { seat_id: SEAT });
  const left = new Date(r.body.booking.expires_at) - Date.now();
  assert.ok(left > 25000 && left <= 30500, `10 min / 20 = 30 s, got ${left}`);
});

test('leaving frees the seat (held → cancelled, occupied → completed)', async () => {
  const a = await user('20000009');
  await call('POST', '/api/book', a, { seat_id: SEAT });
  assert.equal((await call('POST', '/api/leave', a)).body.booking.status, 'cancelled');
  assert.equal(await statusOf(SEAT), 'free');
  await call('POST', '/api/book', a, { seat_id: SEAT });
  await call('POST', '/api/checkin', a, { seat_id: SEAT, k: qrSig(Q, SEAT) });
  assert.equal((await call('POST', '/api/leave', a)).body.booking.status, 'completed');
  assert.equal((await call('POST', '/api/leave', a)).status, 404);
});

test('live stream: a booking reaches subscribers in well under 5 s', async () => {
  const a = await user('20000010');
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/stream', { signal: ctrl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  const got = (async () => {
    for (;;) {
      const { value, done } = await reader.read(); if (done) return null;
      buf += dec.decode(value);
      const m = buf.match(/event: seat\ndata: (.+)\n/);
      if (m) return { data: JSON.parse(m[1]), at: Date.now() };
    }
  })();
  await sleep(100);
  const t0 = Date.now();
  await call('POST', '/api/book', a, { seat_id: SEAT });
  const ev = await got; ctrl.abort();
  assert.equal(ev.data.seat_id, SEAT); assert.equal(ev.data.status, 'held');
  assert.ok(ev.at - t0 < 1000, `delivered in ${ev.at - t0} ms`);
});

test('seats endpoint: per-floor live status, marks my seat', async () => {
  const a = await user('20000011');
  await call('POST', '/api/book', a, { seat_id: SEAT });
  const r = await call('GET', '/api/seats?floor=2', a);
  assert.equal(r.body.seats.length, 129);
  const mine = r.body.seats.find(s => s.id === SEAT);
  assert.equal(mine.status, 'held'); assert.equal(mine.mine, true);
  const f = await call('GET', '/api/floors');
  assert.equal(f.body.floors.length, 3);
  assert.equal(f.body.floors[1].counts.held, 1);
});

test('auth and permissions', async () => {
  assert.equal((await call('POST', '/api/book', null, { seat_id: SEAT })).status, 401);
  const st = await user('20000012');
  assert.equal((await call('GET', '/api/admin/stats', st)).status, 403);
  const bad = await fetch(base + '/api/book', { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${st.token}` }, body: '{}' });
  assert.equal(bad.status, 415, 'non-JSON posts are refused');
  const tampered = { token: st.token.slice(0, -2) + 'xx' };
  assert.equal((await call('GET', '/api/me', tampered)).body.user, null, 'a tampered token is treated as logged out');
  // real login with the seeded demo account
  const ok = await call('POST', '/api/auth/login', null, { reg_no: '12300002', password: 'student-demo-2026' });
  assert.equal(ok.status, 200); assert.equal(ok.body.user.role, 'student');
  const no = await call('POST', '/api/auth/login', null, { reg_no: '12300002', password: 'wrong' });
  assert.equal(no.status, 401);
  const reg = await call('POST', '/api/auth/register', null, { reg_no: '1234', name: 'X', password: 'longenough' });
  assert.equal(reg.status, 400);
  // stale session for a user that no longer exists clears the cookie (no redirect loop)
  const ghost = signSession(S, { id: '00000000-0000-0000-0000-000000000000', role: 'student' });
  const stale = await fetch(base + '/api/me', { headers: { cookie: `carrel_session=${ghost}` } });
  assert.equal((await stale.json()).user, null);
  assert.match(stale.headers.get('set-cookie') || '', /Max-Age=0/);
  // successful logins on shared Wi-Fi NAT are never rate-limited; repeated wrong passwords are
  for (let i = 0; i < 12; i++) assert.equal((await call('POST', '/api/auth/login', null, { reg_no: '12300002', password: 'student-demo-2026' })).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/auth/login', null, { reg_no: '12300003', password: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', null, { reg_no: '12300003', password: 'wrong' })).status, 429);
});

test('admin: stats, hog ledger, manual release, QR sheet', async () => {
  const admin = await user('20000099', 'admin'), hog = await user('20000013');
  await db.query(`update settings set value = '1' where key = 'hold_seconds'`);
  for (const seat of [SEAT, SEAT2]) { await call('POST', '/api/book', hog, { seat_id: seat }); await sleep(1300); }
  const s = await call('GET', '/api/admin/stats', admin);
  assert.equal(s.status, 200);
  assert.equal(s.body.double_bookings, 0);
  assert.ok(s.body.today.auto_released >= 2);
  const h = s.body.hog_ledger.find(x => x.reg_no === '20000013');
  assert.ok(h && h.no_checkin === 2 && h.score >= 4, JSON.stringify(s.body.hog_ledger));
  await db.query(`update settings set value = '600' where key = 'hold_seconds'`);
  await call('POST', '/api/book', hog, { seat_id: SEAT });
  assert.equal((await call('POST', '/api/admin/release', admin, { seat_id: SEAT })).body.released, 1);
  assert.equal(await statusOf(SEAT), 'free');
  const qr = await fetch(base + '/api/admin/qr?floor=1', { headers: { authorization: `Bearer ${admin.token}` } });
  const html = await qr.text();
  assert.equal(qr.status, 200); assert.equal((html.match(/<svg/g) || []).length, 129);
});
