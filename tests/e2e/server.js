// Fresh database + server for browser tests (port 8090, time scale 60× so timers run fast).
import pg from 'pg'; import fs from 'node:fs'; import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.js'; import { seed, DEMO_LOGINS } from '../../db/seed.js';
const ADMIN = process.env.DATABASE_URL, URL_ = ADMIN.replace(/\/[^/]+$/, '/carrel_e2e');
const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
await a.query('drop database if exists carrel_e2e with (force)'); await a.query('create database carrel_e2e'); await a.end();
const p = new pg.Pool({ connectionString: URL_ });
await p.query(fs.readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8'));
await seed(p, { demo: true }); await p.query(`update settings set value='60' where key='time_scale'`); await p.end();
const app = createApp({ databaseUrl: URL_, sessionSecret: 'e2e-session', qrSecret: 'e2e-qr', publicOrigin: 'http://localhost:8090',
  staticDir: fileURLToPath(new URL('../../dist', import.meta.url)), sweepMs: 500, demo: true, demoLogins: DEMO_LOGINS, loginLimit: 1000 });   // all browser tests share one IP
await app.start(8090); console.log('e2e server on 8090');
