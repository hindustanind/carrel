import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createApp } from './app.js';
import { seed, DEMO_LOGINS } from '../db/seed.js';

const env = process.env;
for (const k of ['DATABASE_URL', 'SESSION_SECRET', 'QR_SECRET']) {
  if (!env[k]) { console.error(`Missing ${k}. Copy .env.example to .env.`); process.exit(1); }
}
if (env.NODE_ENV === 'production' && /dev-only/.test(env.SESSION_SECRET + env.QR_SECRET)) {
  console.error('Refusing to start in production with development secrets.'); process.exit(1);
}

// migrate + seed layout on boot (idempotent); demo accounts only outside production unless SEED_DEMO=1
const boot = new pg.Pool({ connectionString: env.DATABASE_URL });
await boot.query(fs.readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8'));
const DEMO = env.NODE_ENV !== 'production' || env.SEED_DEMO === '1';
await seed(boot, { demo: DEMO });
if (env.TIME_SCALE) await boot.query(`update settings set value = $1 where key = 'time_scale'`, [env.TIME_SCALE]);
await boot.end();

const app = createApp({ demo: DEMO, demoLogins: DEMO ? DEMO_LOGINS : null,
  databaseUrl: env.DATABASE_URL, sessionSecret: env.SESSION_SECRET, qrSecret: env.QR_SECRET,
  publicOrigin: env.PUBLIC_ORIGIN || `http://localhost:${env.PORT || 8080}`,
  staticDir: fileURLToPath(new URL('../dist', import.meta.url)),
});
const port = await app.start(Number(env.PORT) || 8080);
console.log(`Carrel running on http://localhost:${port}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.stop(); process.exit(0); });
