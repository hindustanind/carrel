// Tiny client for the Carrel API + live seat stream.
export class ApiError extends Error { constructor(status, body) { super(body?.message || `HTTP ${status}`); this.status = status; this.code = body?.error; } }

const OFFLINE = { error: 'OFFLINE', message: "Can't reach Carrel right now. Check your connection and try again in a moment." };
export async function api(path, { method = 'GET', body } = {}) {
  const post = method !== 'GET';
  for (let attempt = 0; attempt < (post ? 1 : 2); attempt++) {
    let r;
    try {
      r = await fetch(path, { method, credentials: 'same-origin',
        headers: post ? { 'content-type': 'application/json' } : undefined, body: post ? JSON.stringify(body || {}) : undefined });
    } catch {
      if (!post && attempt === 0) { await new Promise(w => setTimeout(w, 400)); continue; }
      throw new ApiError(0, OFFLINE);
    }
    // A proxy or tunnel that can't reach the server answers with an HTML error page, not JSON.
    let data = null;
    const text = await r.text();
    try { data = text ? JSON.parse(text) : null; } catch {
      if (!post && attempt === 0 && (r.status >= 502 || r.status === 0)) { await new Promise(w => setTimeout(w, 400)); continue; }
      throw new ApiError(r.status, OFFLINE);
    }
    if (!r.ok) {
      if (!post && attempt === 0 && r.status >= 502) { await new Promise(w => setTimeout(w, 400)); continue; }
      throw new ApiError(r.status, data);
    }
    return data;
  }
}

// Live seat changes over Server-Sent Events, built to survive real phones and real networks:
//  - a stream that drops (bad campus Wi-Fi, a locked phone, a tab in the background) falls back to polling every 2 s;
//  - every reconnect and every return to the tab refetches once, so changes missed while away are never lost;
//  - a stream held back by a buffering proxy (e.g. a Cloudflare quick tunnel) is detected within 2 s and polling stays on;
//  - a stream that goes silent (the server pings every 15 s) is treated as dead and reopened.
export function live({ onSeat, onState, poll }) {
  let es = null, offset = 0, timer = null, sampled = 0, hellos = 0, lastMsg = Date.now(), closed = false;
  let liveOk = false;                                   // true only when the stream is genuinely live (not buffered by a proxy)
  const runPoll = async () => {
    if (!poll || closed) return;
    try { await poll(); onState?.('live'); } catch { onState?.('polling'); }
  };
  const startPoll = (offline = false) => {
    if (offline) onState?.('polling');
    if (!timer && poll) { timer = setInterval(runPoll, 2000); runPoll(); }
  };
  const stopPoll = () => { clearInterval(timer); timer = null; };
  const resync = () => { runPoll(); };
  const connect = () => {
    es?.close();
    es = new EventSource('/api/stream'); const t0 = Date.now(); liveOk = false; lastMsg = Date.now();
    const guard = setTimeout(() => startPoll(false), 2000);  // no hello within 2 s → start 2 s polling right away
    es.addEventListener('hello', e => {
      clearTimeout(guard); lastMsg = Date.now();
      liveOk = Date.now() - t0 < 2000;
      offset = JSON.parse(e.data).server_now - Date.now();
      if (hellos++ > 0) resync();                       // reconnected: catch up on anything missed
      if (liveOk) { stopPoll(); onState?.('live'); } else startPoll(false);  // buffered stream: keep polling, stay Live while healthy
    });
    es.addEventListener('ping', () => { lastMsg = Date.now(); });
    es.addEventListener('resync', () => { lastMsg = Date.now(); resync(); });
    es.addEventListener('seat', e => {
      lastMsg = Date.now();
      const d = JSON.parse(e.data); onSeat(d);
      // database commit → painted on this screen. Only measured on a visible tab with a genuinely live stream:
      // background tabs pause painting, and buffering proxies delay delivery, and neither is the app's latency.
      if (!liveOk || timer || document.hidden || ++sampled % 3 !== 1) return;
      const arrived = Date.now();
      requestAnimationFrame(() => {
        const painted = Date.now(), ms = painted + offset - d.at;
        if (painted - arrived > 1000 || ms < 0 || ms > 60000) return;
        fetch('/api/metrics/latency', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ms }) }).catch(() => {});
      });
    });
    es.onerror = () => {
      startPoll(true);
      if (es.readyState === EventSource.CLOSED) setTimeout(() => { if (!closed) connect(); }, 3000);   // browser gave up: reopen ourselves
    };
  };
  // Silent for 40 s while expecting SSE (pings come every 15 s) → stream died. Skip churn when already polling over a buffering proxy.
  const watchdog = setInterval(() => { if (!closed && !document.hidden && !timer && Date.now() - lastMsg > 40000) { startPoll(false); connect(); } }, 5000);
  // Phones freeze background tabs and drop their streams. Coming back: refetch now, and reopen the stream if it died.
  const onVisible = () => {
    if (document.hidden || closed) return;
    resync();
    if (!timer && (!es || es.readyState === EventSource.CLOSED || Date.now() - lastMsg > 20000)) connect();
  };
  document.addEventListener('visibilitychange', onVisible);
  addEventListener('pageshow', e => { if (e.persisted) onVisible(); });      // restored from the back/forward cache
  addEventListener('online', onVisible);
  addEventListener('offline', () => onState?.('polling'));
  connect();
  return { serverOffset: () => offset, close: () => { closed = true; es?.close(); stopPoll(); clearInterval(watchdog); document.removeEventListener('visibilitychange', onVisible); } };
}

export function toast(msg, ms = 2600) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast glass'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}
export const fmt = s => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, '0')}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
