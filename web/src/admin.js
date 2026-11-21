// Librarian pages in one shell: Dashboard (/admin), Seats (/admin/seats), Desk QR (/admin/desk).
import { api, live, toast, fmt } from './api.js';
import { mountShell, setActive, setLive, esc, transition, seg } from './shell.js';

const $ = s => document.querySelector(s);
const WORD = { free: 'Free', held: 'Held', break: 'On a break', occupied: 'Taken' };
const VAR = { free: '#EAE1D6', held: 'var(--amber)', break: 'var(--amber)', occupied: 'var(--taken)' };
const TIME = { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' };
const st = { tab: 'dash', floor: 2, offset: 0, floors: [],
  desk: { floor: 1, seats: [], seat: new URLSearchParams(location.search).get('seat') } };

/* ---------------- routing ---------------- */
const tabOf = p => p.startsWith('/admin/seats') ? 'seats' : p.startsWith('/admin/desk') ? 'desk' : 'dash';
function show(tab) {
  st.tab = tab;
  for (const t of ['dash', 'seats', 'desk']) $(`#tab-${t}`).hidden = t !== tab;
  document.title = `Carrel · ${{ dash: 'Dashboard', seats: 'Seats', desk: 'Desk QR' }[tab]}`;
  setActive(tab); refresh();
  if (tab === 'desk') requestAnimationFrame(() => loadDesk.seg?.set(String(D.floor)));
  if (tab === 'seats') requestAnimationFrame(() => renderSeats.seg?.set(String(st.floor)));
}
function navigate(path) { history.pushState(null, '', path); transition(() => show(tabOf(path))); }
addEventListener('popstate', () => show(tabOf(location.pathname)));

/* ---------------- dashboard ---------------- */
async function renderDash() {
  const s = await api('/api/admin/stats');
  const sum = k => Object.values(s.counts).reduce((a, c) => a + (c[k] || 0), 0);
  const total = sum('free') + sum('held') + sum('occupied') + sum('break'), busy = total - sum('free');
  const lat = s.latency_ms.p95;
  $('#kpis').innerHTML = [
    ['In use now', `${Math.round(busy / Math.max(1, total) * 100)}%`, `${busy} of ${total} seats`],
    ['Free seats', sum('free'), 'across 3 floors'],
    ['On a break', sum('break'), `${sum('held')} held, not checked in`],
    ['Released today', s.today.auto_released, `${s.today.check_ins} check-ins today`],
    ['Double bookings', s.double_bookings, 'blocked by the database'],
    ['Live update time', lat == null ? '—' : `${lat} ms`, lat == null ? 'no live screens measured yet' : `95% of updates · ${s.latency_ms.samples} samples`],
  ].map(([k, v, sub]) => `<div><span>${k}</span><b>${v}</b><small>${sub}</small></div>`).join('');
  $('#asof').textContent = `Live · updated ${new Date().toLocaleTimeString('en-IN', TIME)} IST`;

  const grid = {}; let max = 1;
  for (const h of s.heatmap) { grid[`${h.dow}-${h.hr}`] = h.n; max = Math.max(max, h.n); }
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let html = '<span></span>' + Array.from({ length: 24 }, (_, h) => `<span style="justify-content:center">${h % 6 ? '' : h}</span>`).join(''), best = null;
  days.forEach((d, i) => { html += `<span>${d}</span>`; for (let h = 0; h < 24; h++) { const n = grid[`${i + 1}-${h}`] || 0;
    if (!best || n > best.n) best = { n, d, h };
    html += `<i title="${d} ${h}:00 · ${n} seat-hours" style="background:rgba(242,237,225,${(n / max * .85 + .06).toFixed(2)})"></i>`; } });
  $('#heat').innerHTML = html;
  $('#peak').textContent = best?.n ? `Busiest: ${best.d} ${best.h}:00–${best.h + 1}:00` : 'No bookings recorded yet.';

  $('#hogs').innerHTML = s.hog_ledger.length ? s.hog_ledger.map(h => `<tr><td>${esc(h.name)}<span class="sub">${esc(h.reg_no)}</span></td>
    <td>${[h.no_checkin && `${h.no_checkin} hold${h.no_checkin > 1 ? 's' : ''} never checked in`, h.break_timeouts && `${h.break_timeouts} break${h.break_timeouts > 1 ? 's' : ''} ran out`, h.near_limit_breaks && `${h.near_limit_breaks} long break${h.near_limit_breaks > 1 ? 's' : ''}`].filter(Boolean).join(' · ') || '—'}
    <span class="sub">${esc(h.seats.slice(0, 3).join(', '))}</span></td><td class="r"><span class="score">${h.score}</span></td></tr>`).join('')
    : '<tr><td colspan="3" class="meta">Nobody held seats without using them this week.</td></tr>';
}

/* ---------------- seats ---------------- */
let seatsSig = '';
async function renderSeats(force = false) {
  if (!renderSeats.seg) renderSeats.seg = seg($('#floorSeg'), [['1', 'Floor 1'], ['2', 'Floor 2'], ['3', 'Floor 3']], String(st.floor), v => { st.floor = +v; renderSeats(true); });
  const r = await api(`/api/seats?floor=${st.floor}`);
  const seats = r.seats.filter(x => x.status !== 'free');
  const sig = `${st.floor}|` + seats.map(x => `${x.id}:${x.status}:${x.expires_at || ''}`).join(',');
  if (force || sig !== seatsSig) {
    seatsSig = sig;
    $('#active').innerHTML = seats.length ? seats.map(x => `<tr><td>${esc(x.label)}<span class="sub">${x.id}</span></td>
      <td><span class="status ${x.status}">${WORD[x.status]}</span></td>
      <td class="num">${x.expires_at ? new Date(x.expires_at).toLocaleTimeString('en-IN', { ...TIME, second: '2-digit' }) : '—'}</td>
      <td class="r"><button class="btn btn-danger" data-r="${x.id}">Release</button></td></tr>`).join('')
      : `<tr><td colspan="4" class="meta">No seats in use on Floor ${st.floor}.</td></tr>`;
    $('#active').querySelectorAll('[data-r]').forEach(b => b.onclick = async () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap again'; setTimeout(() => { delete b.dataset.armed; b.textContent = 'Release'; }, 4000); return; }
      b.disabled = true;
      await api('/api/admin/release', { method: 'POST', body: { seat_id: b.dataset.r } }); toast(`${b.dataset.r} released.`); renderSeats(true);
    });
  }
  const s = await api('/api/admin/stats');
  $('#scale').querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', String(+b.dataset.s === s.time_scale));
    b.onclick = async () => { await api('/api/admin/time-scale', { method: 'POST', body: { scale: +b.dataset.s } }); toast(+b.dataset.s === 1 ? 'Back to real time.' : `Timers now run ${b.dataset.s}× faster for new holds and breaks.`); renderSeats(); }; });
}

/* ---------------- desk QR ---------------- */
const D = st.desk, cur = () => D.seats.find(s => s.id === D.seat);
async function loadDesk(quiet = false) {
  if (D.seat && !quiet) D.floor = Number(D.seat.match(/^F(\d)/)?.[1]) || D.floor;
  const r = await api(`/api/seats?floor=${D.floor}`);
  D.seats = r.seats; st.offset = r.server_now - Date.now();
  if (!D.seat || !cur()) D.seat = (D.seats.find(s => s.status === 'free') || D.seats[0]).id;
  if (!quiet) {
    if (!loadDesk.seg) loadDesk.seg = seg($('#deskFloors'), [['1', 'Floor 1'], ['2', 'Floor 2'], ['3', 'Floor 3']], String(D.floor), v => { D.floor = +v; D.seat = null; loadDesk(); });
    else loadDesk.seg.set(String(D.floor));
    $('#seatSel').innerHTML = D.seats.map(s => `<option value="${s.id}" ${s.id === D.seat ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
    await renderQr();
  }
  renderPlan(); renderStatus();
}
async function select(id) {
  D.seat = id; $('#seatSel').value = id; $('#log').innerHTML = '';
  history.replaceState(null, '', `/admin/desk?seat=${encodeURIComponent(id)}`);
  await renderQr(); renderPlan(); renderStatus();
}
$('#seatSel').onchange = e => select(e.target.value);
const step = d => { const i = D.seats.findIndex(s => s.id === D.seat); select(D.seats[(i + d + D.seats.length) % D.seats.length].id); };
$('#prev').onclick = () => step(-1); $('#next').onclick = () => step(1);
$('#freeBtn').onclick = () => { const i = D.seats.findIndex(s => s.id === D.seat); const n = [...D.seats.slice(i + 1), ...D.seats.slice(0, i)].find(s => s.status === 'free'); if (n) select(n.id); };
$('#reset').onclick = () => api('/api/admin/release', { method: 'POST', body: { seat_id: D.seat } });
let link = '';
$('#copyLink').onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Desk link copied.'); } catch { toast(link, 6000); } };
async function renderQr() {
  const s = cur(); if (!s) return;
  const r = await api(`/api/admin/desk-qr?seat=${encodeURIComponent(s.id)}`);
  link = r.url;
  const host = new URL(r.url);
  $('#qrHost').textContent = host.hostname.endsWith('trycloudflare.com') ? `Opens ${host.host} · works on any network`
    : /^(localhost|127\.)/.test(host.hostname) ? `Opens ${host.host} · a phone can't reach this. Open this page via the Wi-Fi address or run scripts/tunnel.sh`
    : host.protocol === 'http:' ? `Opens ${host.host} · the phone must be on the same Wi-Fi as this laptop` : `Opens ${host.host}`;
  $('#qr').innerHTML = r.svg.replace(/#1a1e24/gi, '#120F0C');
  $('#pTitle').textContent = s.label;
  $('#pWhere').textContent = `Floor ${D.floor} · ${s.id}`;
}
function renderStatus() {
  const s = cur(); if (!s) return;
  $('#state').style.setProperty('--c', VAR[s.status]);
  $('#sWord').textContent = WORD[s.status];
  const left = s.expires_at ? (new Date(s.expires_at) - (Date.now() + st.offset)) / 1000 : 0;
  $('#sSub').textContent = {
    free: ' · waiting for a scan',
    held: ` · not checked in yet · released in ${fmt(left)}`,
    occupied: ' · checked in at this desk',
    break: ` · on a break · back to everyone in ${fmt(left)}`,
  }[s.status];
}
const X = x => 20 + (x + 22) / 44 * 860, Y = y => 20 + (15 - y) / 30 * 560;
function renderPlan() {
  if ($('#plan').hidden) return;
  const g = ['<rect x="20" y="20" width="860" height="560" rx="10" fill="rgba(236,238,226,.03)" stroke="rgba(236,238,226,.16)"/>'];
  for (const s of D.seats) {
    const me = s.id === D.seat;
    if (me) g.push(`<circle class="me" cx="${X(s.x)}" cy="${Y(s.y)}" r="16" fill="none" stroke="#f2ede1" stroke-width="2"/>`);
    g.push(`<circle data-id="${s.id}" cx="${X(s.x)}" cy="${Y(s.y)}" r="${me ? 8 : 6}" fill="${VAR[s.status]}" style="cursor:pointer"><title>${esc(s.label)} · ${WORD[s.status]}</title></circle>`);
  }
  $('#plan').innerHTML = `<svg viewBox="0 0 900 600">${g.join('')}</svg>`;
  $('#plan').querySelectorAll('[data-id]').forEach(c => c.onclick = () => select(c.dataset.id));
}
function log(text) {
  const t = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  $('#log').insertAdjacentHTML('afterbegin', `<div><time>${t}</time><span>${esc(text)}</span></div>`);
}
let pend = null;
function deskEvent(d, to) {
  const s = D.seats.find(x => x.id === d.seat_id); if (!s) return;
  const from = s.status; s.status = to; s.expires_at = to === 'free' ? null : d.expires_at;
  if (s.id === D.seat && from !== to) {
    // a walk-up scan is hold + check-in in one transaction: two events, one log line
    const ms = Math.max(0, Math.round(Date.now() + st.offset - d.at));
    if (pend) { pend.to = to; pend.ms = ms; } else pend = { from, to, ms };
    clearTimeout(pend.h); pend.h = setTimeout(() => {
      if (pend.from !== pend.to) {
        log(`${{ held: 'Held from the seat finder', occupied: pend.from === 'break' ? 'Back from a break' : 'Checked in by scanning this desk', break: 'Student started a break', free: 'Seat released' }[pend.to]} · reached this screen in ${pend.ms} ms`);
        const el = $('#state'); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      }
      pend = null;
    }, 200);
  }
  renderPlan(); renderStatus();
}

/* ---------------- live ---------------- */
let t = null;
function onSeat(d) {
  const to = ['held', 'occupied', 'break'].includes(d.status) ? d.status : 'free';
  if (st.tab === 'desk') deskEvent(d, to);
  clearTimeout(t); t = setTimeout(refresh, 500);
}
async function refresh() {
  try {
    if (st.tab === 'dash') await renderDash();
    if (st.tab === 'seats') await renderSeats();
    if (st.tab === 'desk') await loadDesk(D.seats.length > 0 && cur() != null);
  } catch (e) { console.error(e); }
}

/* ---------------- boot ---------------- */
(async () => {
  const me = await api('/api/me');
  if (me.user?.role !== 'admin') return void (location.href = '/');
  if (!me.demo) document.getElementById('scale')?.closest('.card')?.setAttribute('hidden', '');   // demo speed only in demo mode
  mountShell({ me: me.user, active: tabOf(location.pathname), onNav: href => href.startsWith('/admin') ? (navigate(href), true) : false });
  if (tabOf(location.pathname) === 'desk') await loadDesk();
  show(tabOf(location.pathname));
  live({ onSeat, poll: refresh, onState: setLive });
  setInterval(() => { if (st.tab === 'desk') renderStatus(); }, 1000);
  setInterval(() => { if (st.tab === 'dash') renderDash().catch(() => {}); }, 15000);
})();
