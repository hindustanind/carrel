// Public concurrency test for judges: N students race for ONE seat; exactly one must win.
//   node scripts/loadtest.js [baseUrl] [students=500] [seat=F2-T07-S3]
// Uses the API exactly like the app does (register → book). Safe to run against a demo deployment.
import http from 'node:http'; import https from 'node:https';
const [base = 'http://localhost:8080', n = '500', seat = 'F2-T07-S3'] = process.argv.slice(2);
const N = Number(n), lib = base.startsWith('https') ? https : http, agent = new lib.Agent({ keepAlive: true, maxSockets: 64 });
const req = (path, body, cookie) => new Promise((res, rej) => {
  const data = JSON.stringify(body || {});
  const r = lib.request(base + path, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(cookie ? { cookie } : {}) } }, s => {
    let b = ''; s.on('data', c => b += c); s.on('end', () => res({ status: s.statusCode, cookie: (s.headers['set-cookie'] || [])[0]?.split(';')[0], body: b }));
  }); r.on('error', rej); r.end(data);
});
const run = Date.now().toString().slice(-4);
console.log(`Creating ${N} test students…`);
const users = [];
for (let i = 0; i < N; i += 50) users.push(...await Promise.all(Array.from({ length: Math.min(50, N - i) }, (_, k) =>
  req('/api/auth/register', { reg_no: `9${run}${String(i + k).padStart(3, '0')}`, name: `Load ${i + k}`, password: 'loadtest-pass-1' }))));
const cookies = users.map(u => u.cookie).filter(Boolean);
console.log(`Racing ${cookies.length} students for ${seat}…`);
const t0 = Date.now();
const results = await Promise.all(cookies.map(c => req('/api/book', { seat_id: seat }, c)));
const ms = Date.now() - t0, by = results.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
console.log(`Done in ${ms} ms →`, by);
console.log(by[201] === 1 ? `PASS: exactly one booking, ${by[409] || 0} clean "seat taken" responses.` : 'FAIL: expected exactly one 201.');
// tidy up: the winner leaves the seat
const win = results.findIndex(r => r.status === 201); if (win >= 0) await req('/api/leave', {}, cookies[win]);
process.exit(by[201] === 1 ? 0 : 1);
