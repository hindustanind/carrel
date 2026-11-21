// Seeds floors, 3 × 129 seats from the Blender reading-floor layout, and demo accounts.
// Safe to re-run: seats/floors upsert; demo users are created only if missing.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hashPassword } from '../server/auth.js';

const here = p => fileURLToPath(new URL(p, import.meta.url));
export const FLOORS = [
  { id: 1, name: 'Reading hall A', meta: 'Long tables · window carrels' },
  { id: 2, name: 'Reading hall B', meta: 'Stacks · lounge · plug points' },
  { id: 3, name: 'Quiet floor',    meta: 'Silent zone · periodicals' },
];

// seat order in the layout: 96 table seats (16 tables × 6), 9 window carrels, 24 lounge seats
export function describe(i) {
  if (i < 96) {
    const t = Math.floor(i / 6) + 1, s = (i % 6) + 1;
    return { zone: 'T', code: `T${String(t).padStart(2, '0')}-S${s}`, label: `Table ${String(t).padStart(2, '0')} · Seat ${s}`,
             amenities: [s % 3 === 1 ? 'Plug point' : null, t <= 4 ? 'Faces the stacks' : null, 'Reading lamp'].filter(Boolean) };
  }
  if (i < 105) {
    const c = i - 95;
    return { zone: 'C', code: `C${c}`, label: `Window carrel ${c}`, amenities: ['Window', 'Plug point', 'Quiet'] };
  }
  const l = Math.floor((i - 105) / 4) + 1, s = ((i - 105) % 4) + 1;
  return { zone: 'L', code: `L${l}-S${s}`, label: `Lounge ${l} · Seat ${s}`, amenities: ['Group friendly'] };
}

// Demo accounts: created only when demo mode is on (never in production unless SEED_DEMO=1).
export const DEMO_USERS = [
  ['12300001', 'Library Admin', 'admin', 'admin-demo-2026'],
  ['12300002', 'Demo Student', 'student', 'student-demo-2026'],
  ['12300003', 'Judge One', 'student', 'judge-demo-2026'],
  ['12300004', 'Judge Two', 'student', 'judge-demo-2026'],
];
export const DEMO_LOGINS = { student: { reg_no: DEMO_USERS[1][0], password: DEMO_USERS[1][3] }, admin: { reg_no: DEMO_USERS[0][0], password: DEMO_USERS[0][3] } };

export async function seed(pool, { demo = true } = {}) {
  const layout = JSON.parse(fs.readFileSync(here('./layout.json'), 'utf8'));
  const c = await pool.connect();
  try {
    await c.query('begin');
    for (const f of FLOORS) {
      await c.query('insert into floors(id,name,meta) values($1,$2,$3) on conflict (id) do update set name=$2, meta=$3', [f.id, f.name, f.meta]);
      for (let i = 0; i < layout.length; i++) {
        const d = describe(i), s = layout[i];
        await c.query(`insert into seats(id,floor_id,zone,label,x,y,face,amenities) values($1,$2,$3,$4,$5,$6,$7,$8)
                       on conflict (id) do update set zone=$3,label=$4,x=$5,y=$6,face=$7,amenities=$8`,
          [`F${f.id}-${d.code}`, f.id, d.zone, d.label, s.x, s.y, s.face, d.amenities]);
      }
    }
    if (demo) {
      for (const [reg, name, role, pw] of DEMO_USERS) {
        await c.query('insert into users(reg_no,name,role,pass_hash) values($1,$2,$3,$4) on conflict (reg_no) do nothing',
          [reg, name, role, await hashPassword(pw)]);
      }
    }
    await c.query('commit');
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  return { floors: FLOORS.length, seatsPerFloor: JSON.parse(fs.readFileSync(here('./layout.json'), 'utf8')).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(fs.readFileSync(here('./schema.sql'), 'utf8'));
  console.log('seeded', await seed(pool));
  await pool.end();
}
