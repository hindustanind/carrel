// Carrel API: plain node:http, Postgres for every rule, SSE for live seat changes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pg from 'pg';
import QRCode from 'qrcode';
import { verifyPassword, hashPassword, signSession, readSession, verifyQr, qrUrl } from './auth.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.otf': 'font/otf',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
const KNOWN = { NO_SUCH_SEAT: [404, 'That seat does not exist.'], SEAT_TAKEN: [409, 'Someone just took that seat.'],
  YOU_ALREADY_HAVE_A_SEAT: [409, 'You already have a seat. Leave it first.'], NOT_YOUR_SEAT: [403, 'This seat is not held by you.'],
  NOT_CHECKED_IN: [409, 'Check in at your desk first.'], NO_ACTIVE_SEAT: [404, 'You have no active seat.'] };

export function createApp({ databaseUrl, sessionSecret, qrSecret, publicOrigin, staticDir, sweepMs = 5000, demo = false, demoLogins = null, loginLimit = 10, log = console }) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 20 });
  const clients = new Set();               // SSE connections
  const latency = [];                      // client-reported publish → paint latencies (ms)
  const attempts = new Map();              // login rate limit: ip -> [timestamps]
  let listener = null, sweeper = null;

  /* ---------- realtime fan-out ---------- */
  // An idle pooled connection that dies (DB restart, Wi-Fi drop) emits 'error'; unhandled, that would crash the server.
  pool.on('error', e => log.error('pg pool', e.message));
  let stopping = false, relistenT = null;
  function relisten(why) {
    if (stopping) return;
    log.error('listener lost:', why);
    listener?.end().catch(() => {}); listener = null;
    clearTimeout(relistenT);
    // Notifications sent while we were away are gone: tell every screen to refetch once we are back.
    relistenT = setTimeout(() => listen().then(() => broadcast('resync', '{}')).catch(e => relisten(e.message)), 2000);
  }
  async function listen() {
    const c = new pg.Client({ connectionString: databaseUrl });
    listener = c;
    c.on('error', e => { if (listener === c) relisten(e.message); });
    c.on('end', () => { if (listener === c) relisten('connection ended'); });
    c.on('notification', m => broadcast('seat', m.payload));
    await c.connect();
    await c.query('listen seat_changes');
  }
  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${data}\n\n`;
    for (const res of clients) res.write(frame);
  }

  /* ---------- helpers ---------- */
  const send = (res, code, body, headers = {}) => {
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(json);
  };
  const fail = (res, e) => {
    const code = (e.message || '').match(/^[A-Z_]+$/) ? e.message : null;
    if (code && KNOWN[code]) return send(res, KNOWN[code][0], { error: code, message: KNOWN[code][1] });
    log.error(e); return send(res, 500, { error: 'SERVER', message: 'Something went wrong.' });
  };
  const body = req => new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('BAD_JSON')); } });
  });
  const cookie = (req, k) => (req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(([n]) => n === k)?.[1];
  const session = req => readSession(sessionSecret, cookie(req, 'carrel_session') || (req.headers.authorization || '').replace(/^Bearer /, ''));
  const secure = publicOrigin.startsWith('https');
  const setCookie = (tok, req) => `carrel_session=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${tok ? 43200 : 0}${secure || req?.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
  const pub = r => r && ({ id: r.id, seat_id: r.seat_id, status: r.status, expires_at: r.expires_at, checked_in_at: r.checked_in_at, created_at: r.created_at, duration_s: r.duration_s || 7200 });
  const ip = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const recentFails = (key, now) => {
    const list = (attempts.get(key) || []).filter(t => now - t < 60000);
    if (list.length) attempts.set(key, list); else attempts.delete(key);
    return list;
  };

  async function counts() {
    const { rows } = await pool.query(`select floor_id, status, count(*)::int n from seat_status group by 1,2`);
    const by = {}; for (const r of rows) (by[r.floor_id] ||= { free: 0, held: 0, occupied: 0, break: 0 })[r.status] = r.n;
    return by;
  }

  /* ---------- routes ---------- */
  const routes = {
    'GET /api/health': async (req, res) => { await pool.query('select 1'); send(res, 200, { ok: true, clients: clients.size, now: Date.now() }); },

    'POST /api/auth/login': async (req, res) => {
      const { reg_no, password } = await body(req);
      const reg = String(reg_no || '').trim();
      const addr = ip(req), acctKey = `${addr}:${reg}`, now = Date.now();
      // Only failed logins count toward the rate limit, so many students on the same campus Wi-Fi NAT never lock each other out.
      const acctFails = recentFails(acctKey, now), ipFails = recentFails(addr, now);
      if (acctFails.length >= loginLimit || ipFails.length >= loginLimit * 3)
        return send(res, 429, { error: 'RATE_LIMITED', message: 'Too many failed attempts. Wait a minute.' });
      const { rows: [u] } = await pool.query('select * from users where reg_no = $1', [reg]);
      if (!u || !(await verifyPassword(String(password || ''), u.pass_hash))) {
        attempts.set(acctKey, [...acctFails, now]);
        attempts.set(addr, [...ipFails, now]);
        return send(res, 401, { error: 'BAD_LOGIN', message: 'Registration number or password is wrong.' });
      }
      attempts.delete(acctKey);
      send(res, 200, { user: { id: u.id, name: u.name, reg_no: u.reg_no, role: u.role } }, { 'set-cookie': setCookie(signSession(sessionSecret, u), req) });
    },
    'POST /api/auth/register': async (req, res) => {
      const { reg_no, name, password } = await body(req);
      if (!/^[0-9]{8}$/.test(String(reg_no || ''))) return send(res, 400, { error: 'BAD_REG', message: 'Use your 8-digit LPU registration number.' });
      if (!name || String(name).trim().length < 2) return send(res, 400, { error: 'BAD_NAME', message: 'Enter your name.' });
      if (String(password || '').length < 8) return send(res, 400, { error: 'BAD_PASSWORD', message: 'Password must be at least 8 characters.' });
      try {
        const { rows: [u] } = await pool.query('insert into users(reg_no,name,pass_hash) values($1,$2,$3) returning *', [reg_no, String(name).trim().slice(0, 60), await hashPassword(password)]);
        send(res, 201, { user: { id: u.id, name: u.name, reg_no: u.reg_no, role: u.role } }, { 'set-cookie': setCookie(signSession(sessionSecret, u), req) });
      } catch (e) { if (e.code === '23505') return send(res, 409, { error: 'EXISTS', message: 'That registration number already has an account.' }); throw e; }
    },
    'POST /api/auth/logout': async (req, res) => send(res, 200, { ok: true }, { 'set-cookie': setCookie('', req) }),

    'GET /api/me': async (req, res, s) => {
      if (!s) return send(res, 200, { user: null, booking: null, demo, demo_logins: demo ? demoLogins : undefined, server_now: Date.now() });
      const { rows: [u] } = await pool.query('select id,name,reg_no,role from users where id = $1', [s.uid]);
      if (!u) return send(res, 200, { user: null, booking: null, demo, demo_logins: demo ? demoLogins : undefined, server_now: Date.now() }, { 'set-cookie': setCookie('', req) });
      await pool.query(`select release_expired(seat_id) from bookings where user_id = $1 and status in ('held','break')`, [s.uid]);
      const { rows: [b] } = await pool.query(`select b.*, s.label, s.floor_id from bookings b join seats s on s.id = b.seat_id
                                              where b.user_id = $1 and b.status in ('held','occupied','break')`, [s.uid]);
      send(res, 200, { user: u, booking: b ? { ...pub(b), label: b.label, floor_id: b.floor_id } : null, demo, server_now: Date.now() });
    },

    // Profile: your own study history. Time studied = check-in → end (or now), so breaks count as library time.
    'GET /api/me/history': async (req, res, s) => {
      if (!s) return send(res, 401, { error: 'LOGIN_REQUIRED', message: 'Log in with your registration number.' });
      const span = `extract(epoch from coalesce(b.ended_at, now()) - b.checked_in_at)`;
      const [{ rows: [t] }, { rows: week }, { rows: recent }] = await Promise.all([
        pool.query(`select coalesce(sum(${span}) filter (where b.checked_in_at is not null), 0)::int study_s,
                           count(*) filter (where b.checked_in_at is not null)::int check_ins,
                           count(*) filter (where b.status = 'released' and b.checked_in_at is null)::int no_shows
                      from bookings b where b.user_id = $1`, [s.uid]),
        pool.query(`select extract(isodow from (b.checked_in_at at time zone 'Asia/Kolkata'))::int dow, sum(${span})::int secs
                      from bookings b where b.user_id = $1 and b.checked_in_at > now() - interval '7 days'
                     group by 1`, [s.uid]),
        pool.query(`select b.seat_id, s.label, s.floor_id, b.status, b.end_reason, b.created_at, b.checked_in_at, b.ended_at,
                           case when b.checked_in_at is not null then (${span})::int end secs
                      from bookings b join seats s on s.id = b.seat_id where b.user_id = $1 order by b.created_at desc limit 6`, [s.uid]),
      ]);
      const byDow = Object.fromEntries(week.map(w => [w.dow, w.secs]));
      send(res, 200, { ...t, week: [1, 2, 3, 4, 5, 6, 7].map(d => ({ dow: d, secs: byDow[d] || 0 })), recent });
    },
    'GET /api/floors': async (req, res) => {
      const [{ rows: floors }, by] = await Promise.all([pool.query('select * from floors order by id'), counts()]);
      const { rows: [t] } = await pool.query('select count(*)::int total from seats where active');
      send(res, 200, { floors: floors.map(f => ({ ...f, counts: by[f.id] || {}, total: t.total / floors.length })) });
    },
    'GET /api/seats': async (req, res, s, url) => {
      const floor = Number(url.searchParams.get('floor')) || 1;
      await pool.query('select release_expired()');
      const { rows } = await pool.query(`select id, zone, label, x, y, face, amenities, status, expires_at,
                                         (user_id = $2) as mine from seat_status where floor_id = $1 order by id`, [floor, s?.uid || null]);
      send(res, 200, { floor, seats: rows, server_now: Date.now() });
    },
    'GET /api/stream': async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.flushHeaders?.(); req.socket.setNoDelay(true);
      res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ server_now: Date.now() })}\n\n`);
      clients.add(res);
      // A named event (not a comment) so browsers can tell a quiet-but-healthy stream from a dead or buffered one.
      const ping = setInterval(() => res.write(`event: ping\ndata: ${Date.now()}\n\n`), 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
    },

    'POST /api/book': async (req, res, s) => {
      const { seat_id, duration_min } = await body(req);
      const mins = [30, 60, 120, 180].includes(Number(duration_min)) ? Number(duration_min) : 120;
      const { rows: [b] } = await pool.query('select * from book_seat($1, $2, $3)', [s.uid, seat_id, mins * 60]);
      send(res, 201, { booking: pub(b) });
    },
    'POST /api/checkin': async (req, res, s) => {
      const { seat_id, k } = await body(req);
      if (!verifyQr(qrSecret, seat_id, k)) return send(res, 400, { error: 'BAD_QR', message: 'That QR code is not a valid Carrel desk code.' });
      const { rows: [b] } = await pool.query('select * from check_in($1, $2)', [s.uid, seat_id]);
      send(res, 200, { booking: pub(b) });
    },
    // walk-up: a student with no seat scans a free desk. Signature first, then hold + check-in together.
    'POST /api/walkin': async (req, res, s) => {
      const { seat_id, k } = await body(req);
      if (!verifyQr(qrSecret, seat_id, k)) return send(res, 400, { error: 'BAD_QR', message: 'That QR code is not a valid Carrel desk code.' });
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('select * from book_seat($1, $2)', [s.uid, seat_id]);
        const { rows: [b] } = await c.query('select * from check_in($1, $2)', [s.uid, seat_id]);
        await c.query('commit');
        send(res, 200, { booking: pub(b) });
      } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    },
    'POST /api/break': async (req, res, s) => { const { rows: [b] } = await pool.query('select * from start_break($1)', [s.uid]); send(res, 200, { booking: pub(b) }); },
    'POST /api/leave': async (req, res, s) => { const { rows: [b] } = await pool.query('select * from end_session($1)', [s.uid]); send(res, 200, { booking: pub(b) }); },
    'POST /api/metrics/latency': async (req, res) => {
      const { ms } = await body(req);
      if (Number.isFinite(ms) && ms >= 0 && ms < 60000) { latency.push(ms); if (latency.length > 2000) latency.shift(); }
      send(res, 204, '');
    },

    /* ---------- admin ---------- */
    'GET /api/admin/stats': async (req, res) => {
      const by = await counts();
      const q = sql => pool.query(sql).then(r => r.rows);
      const [[today], [dup], heat, hogs, [cfg]] = await Promise.all([
        q(`select count(*) filter (where kind like 'released_%')::int auto_released,
                  count(*) filter (where kind = 'held')::int bookings,
                  count(*) filter (where kind = 'checked_in')::int check_ins
             from seat_events where at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`),
        q(`select count(*)::int n from (select seat_id from bookings where status in ('held','occupied','break') group by seat_id having count(*) > 1) d`),
        q(`select extract(isodow from h at time zone 'Asia/Kolkata')::int dow, extract(hour from h at time zone 'Asia/Kolkata')::int hr, count(*)::int n
             from bookings b, generate_series(date_trunc('hour', b.created_at), coalesce(b.ended_at, now()), interval '1 hour') h
            where b.created_at > now() - interval '28 days' group by 1,2`),
        q(`with ev as (select * from seat_events where at > now() - interval '7 days' and user_id is not null),
                lim as (select setting_seconds('break_seconds') b)
           select array_agg(distinct e.seat_id) seats, u.reg_no, u.name,
                  count(*) filter (where kind = 'released_no_checkin')::int no_checkin,
                  count(*) filter (where kind = 'released_break_timeout')::int break_timeouts,
                  count(*) filter (where kind = 'resumed' and dur_s >= (select b from lim) * .85)::int near_limit_breaks,
                  coalesce(sum(dur_s) filter (where kind = 'resumed'), 0)::int break_seconds
             from ev e join users u on u.id = e.user_id group by 2,3`),
        q(`select (select value from settings where key='time_scale') time_scale`),
      ]);
      const ledger = hogs.map(h => ({ ...h, score: +(2 * h.no_checkin + 2 * h.break_timeouts + h.near_limit_breaks + h.break_seconds / 3600).toFixed(2) }))
        .filter(h => h.score >= 2).sort((a, b) => b.score - a.score).slice(0, 12);
      const sorted = [...latency].sort((a, b) => a - b), pct = p => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]) : null;
      send(res, 200, { counts: by, today, double_bookings: dup.n, heatmap: heat, hog_ledger: ledger,
        latency_ms: { p50: pct(.5), p95: pct(.95), samples: sorted.length }, live_clients: clients.size, time_scale: Number(cfg.time_scale) });
    },
    'POST /api/admin/release': async (req, res) => {
      const { seat_id } = await body(req);
      const { rows: [r] } = await pool.query('select admin_release($1) n', [seat_id]);
      send(res, 200, { released: r.n });
    },
    'POST /api/admin/time-scale': async (req, res) => {
      const { scale } = await body(req);
      const v = Math.min(120, Math.max(1, Math.round(Number(scale) || 1)));
      await pool.query(`update settings set value = $1 where key = 'time_scale'`, [String(v)]);
      send(res, 200, { time_scale: v });
    },
    'GET /api/admin/qr': async (req, res, s, url) => {
      const floor = Number(url.searchParams.get('floor')) || 1;
      const { rows } = await pool.query('select id, label from seats where floor_id = $1 and active order by id', [floor]);
      const origin = await deskOrigin(req);
      const cards = await Promise.all(rows.map(async r => {
        const svg = await QRCode.toString(qrUrl(origin, qrSecret, r.id), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return `<figure>${svg}<figcaption><b>${r.id}</b><span>${r.label}</span></figcaption></figure>`;
      }));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset=utf-8><title>Carrel desk QR codes · Floor ${floor}</title>
        <style>body{font:12px system-ui;margin:16px}main{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
        figure{margin:0;border:1px solid #ccc;border-radius:8px;padding:8px;text-align:center;break-inside:avoid}
        svg{width:100%;height:auto}figcaption b{display:block}figcaption span{color:#666}@media print{body{margin:0}}</style>
        <h1>Floor ${floor}: desk QR codes (${rows.length})</h1><p>Print and stick one on each desk. Codes are signed and cannot be edited.</p><main>${cards.join('')}</main>`);
    },
    'GET /api/admin/qr-link': async (req, res, s, url) => {     // for testing / judges: the URL a desk QR encodes
      const id = url.searchParams.get('seat');
      send(res, 200, { url: qrUrl(await deskOrigin(req), qrSecret, id) });
    },
  };
  // Where a desk QR must point so that a *phone* can open it. Production: always PUBLIC_ORIGIN.
  // Development, in order: DESK_ORIGIN → a live quick tunnel (.tunnel-url) → the host the admin is browsing on,
  // if a phone can reach it → this machine's Wi-Fi address → PUBLIC_ORIGIN.
  const tunnel = { url: null, ok: false, checked: 0, pending: null };
  async function liveTunnel() {
    let t = null;
    try { t = fs.readFileSync(new URL('../.tunnel-url', import.meta.url), 'utf8').trim(); } catch {}
    if (!t || !/^https:\/\/[\w.-]+$/.test(t)) return null;
    // A stale file (tunnel stopped or its random URL expired) used to put a dead link into every QR. Probe it.
    if (t !== tunnel.url || Date.now() - tunnel.checked > 20000) {
      tunnel.pending ||= fetch(`${t}/api/health`, { signal: AbortSignal.timeout(6000) })
        .then(r => r.ok).catch(() => false)
        .then(ok => { Object.assign(tunnel, { url: t, ok, checked: Date.now(), pending: null }); if (!ok) log.warn?.(`desk QR: tunnel ${t} is not reachable, using the Wi-Fi address`); });
      await tunnel.pending;
    }
    return tunnel.ok ? t : null;
  }
  const loopback = h => /^(localhost|127\.|\[?::1\]?|0\.0\.0\.0)/.test(h);
  function lanAddress() {
    const ifs = os.networkInterfaces();
    const all = Object.entries(ifs).flatMap(([name, list]) => (list || []).map(i => ({ ...i, name })))
      .filter(i => i.family === 'IPv4' && !i.internal);
    const priv = a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
    // Prefer real Wi-Fi/Ethernet (en*, wlan*, eth*) over VPN, Docker and bridge interfaces.
    return (all.find(i => /^(en|wlan|wl|eth)/.test(i.name) && priv(i.address)) || all.find(i => priv(i.address)) || all[0])?.address;
  }
  async function deskOrigin(req) {
    if (process.env.DESK_ORIGIN) return process.env.DESK_ORIGIN.replace(/\/$/, '');
    if (process.env.NODE_ENV === 'production') return publicOrigin;
    const t = await liveTunnel(); if (t) return t;
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (host && !loopback(host)) return `${req.headers['x-forwarded-proto'] || 'http'}://${host}`;
    const lan = lanAddress(), port = host.split(':')[1] || '80';
    return lan ? `http://${lan}:${port}` : publicOrigin;
  }
  routes['GET /api/admin/desk-origin'] = async (req, res) => send(res, 200, { origin: await deskOrigin(req) });
  routes['GET /api/admin/desk-qr'] = async (req, res, s, url) => {
    const id = url.searchParams.get('seat');
    const { rows: [seat] } = await pool.query('select id, label, floor_id from seats where id = $1', [id]);
    if (!seat) return send(res, 404, { error: 'NO_SUCH_SEAT', message: 'That seat does not exist.' });
    const link = qrUrl(await deskOrigin(req), qrSecret, seat.id);
    const svg = await QRCode.toString(link, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#1a1e24', light: '#00000000' } });
    send(res, 200, { seat, url: link, svg });
  };
  const NEEDS_AUTH = new Set(['POST /api/walkin', 'POST /api/book', 'POST /api/checkin', 'POST /api/break', 'POST /api/leave']);

  /* ---------- static ---------- */
  function serveStatic(req, res, url) {
    if (!staticDir) return send(res, 404, { error: 'NOT_FOUND' });
    let p = decodeURIComponent(url.pathname);
    // Login first: pages after login need a session; the login page sends you on if you already have one.
    const s = session(req), home = s?.role === 'admin' ? '/admin' : '/home';
    const go = to => { res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end(); };
    const toLogin = () => go(`/?next=${encodeURIComponent(url.pathname + url.search)}`);
    if (p === '/') { if (s) return go(home); p = '/index.html'; }
    else if (p === '/tour') return go('/home');
    else if (p === '/app' || p === '/find') return go('/reserve' + url.search);
    else if (p === '/desk') return go('/admin/desk' + url.search);
    else if (['/home', '/reserve', '/me', '/profile'].includes(p) || p.startsWith('/s/')) { if (!s) return toLogin(); p = '/app.html'; }
    else if (p === '/admin' || p.startsWith('/admin/')) { if (!s) return toLogin(); if (s.role !== 'admin') return go('/home'); p = '/admin.html'; }
    const file = path.join(staticDir, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(staticDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'NOT_FOUND' });
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=604800' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) return url.pathname.startsWith('/api/') ? send(res, 404, { error: 'NOT_FOUND' }) : serveStatic(req, res, url);
    try {
      if (req.method === 'POST' && !(req.headers['content-type'] || '').includes('application/json'))
        return send(res, 415, { error: 'JSON_ONLY', message: 'Send JSON.' });   // also blocks simple cross-site form posts
      const s = session(req);
      if ((NEEDS_AUTH.has(key)) && !s) return send(res, 401, { error: 'LOGIN_REQUIRED', message: 'Log in with your registration number.' });
      if (url.pathname.startsWith('/api/admin/') && s?.role !== 'admin') return send(res, 403, { error: 'ADMIN_ONLY', message: 'Admins only.' });
      await handler(req, res, s, url);
    } catch (e) {
      if (e.message === 'BAD_JSON') return send(res, 400, { error: 'BAD_JSON', message: 'Invalid JSON.' });
      fail(res, e);
    }
  });

  return {
    server, pool,
    async start(port) {
      await listen();
      sweeper = setInterval(() => pool.query('select release_expired()').catch(e => log.error('sweep', e.message)), sweepMs);
      await new Promise(r => server.listen(port, r));
      return server.address().port;
    },
    async stop() {
      stopping = true; clearTimeout(relistenT);
      clearInterval(sweeper);
      for (const c of clients) c.end();
      await new Promise(r => server.close(r));
      await listener?.end().catch(() => {});
      await pool.end();
    },
  };
}
