// Carrel student app v3 — Home, Reserve, My seat, Profile on one page, all over the 3D library scene.
// Every rule (one seat per student, no double booking, timers) is enforced by the server and Postgres.
import { api, live, toast, fmt, ApiError } from './api.js';
import { mountShell, setActive, setBookingDot, setLive, seatName, esc, transition, seg, fx } from './shell.js';

const $ = s => document.querySelector(s);
const body = document.body;
const PHONE = () => innerWidth < 760;
const ZONE = { T: 'Reading tables', C: 'Window carrels', L: 'Lounge' };
const WORD = { free: 'Free', held: 'Held', break: 'On a break', occupied: 'Taken' };
const TIME = { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' };
const params = new URLSearchParams(location.search);
const initFloor = Number(params.get('floor')) || Number(params.get('seat')?.match(/^F(\d)/)?.[1]) || Number(location.pathname.match(/^\/s\/F(\d)/)?.[1]) || 1;
const state = { me: null, booking: null, floors: [], floor: initFloor, seats: [], offset: 0,
  route: 'home', preview: null, note: '', leaving: false, phase: null, busy: false, duration: 120 };
const durLabel = mins => mins < 60 ? `${mins} min` : mins === 60 ? '1 hr' : `${mins / 60} hrs`;

const zoneOf = id => ZONE[(String(id).split('-')[1] || '')[0]] || '';
const seatViewSrc = id => `/assets/seatviews/${String(id).split('-').slice(1).join('-')}.jpg`;
const floorName = id => state.floors.find(f => f.id === id)?.name || '';
const floorLabel = id => { const n = floorName(id); return n ? `Floor ${id} · ${n}` : `Floor ${id}`; };
const now = () => Date.now() + state.offset;
const clockTime = t => new Date(t).toLocaleTimeString('en-IN', TIME);
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const animate = (ms, fn) => new Promise(res => { const t0 = performance.now(); const step = n => { const t = Math.min(1, (n - t0) / ms); fn(t); t < 1 ? requestAnimationFrame(step) : res(); }; requestAnimationFrame(step); });
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ================= data ================= */
async function loadMe() {
  const prev = state.booking;
  const r = await api('/api/me');
  if (!r.user) return void (location.href = `/?next=${encodeURIComponent(location.pathname + location.search)}`);
  state.me = r.user; state.offset = r.server_now - Date.now();
  if (state.leaving) return;                                       // don't let an in-flight background poll resurrect a seat we're leaving
  state.booking = r.booking;
  if (prev && !r.booking && Date.now() - (state.leftAt || 0) > 4000)   // a timer ran out while you were watching
    state.note = prev.status === 'break' ? `Your break at ${prev.label} ran out, so the seat went back to everyone.`
                                         : `Your hold on ${prev.label} ran out before you checked in, so it went back to everyone.`;
  if (r.booking) state.note = '';
  setBookingDot(r.booking);
  if (state.route === 'home') renderHome();
  if (state.route === 'me') renderMe();
}
async function loadFloors() { state.floors = (await api('/api/floors')).floors; renderHome(); renderFloorMeta(); if (state.route === 'me' && state.booking) $('#pMeta').textContent = [floorLabel(state.booking.floor_id), zoneOf(state.booking.seat_id)].filter(Boolean).join(' · '); }
async function loadSeats() {
  const r = await api(`/api/seats?floor=${state.floor}`);
  state.seats = r.seats; state.offset = r.server_now - Date.now();
  paintPlan();
}

/* ================= scene ================= */
const cam = $('#cam'), camImg = $('#camImg'), view = $('#view'), viewImg = $('#viewImg');
const HALL = '/assets/views/hall.jpg', SPOT = '/assets/views/spotH.jpg', FLY1 = '/assets/fly/f0001.jpg';
async function setCam(src) {
  if (camImg.getAttribute('src') === src) return;
  camImg.style.opacity = 0; await new Promise(r => setTimeout(r, reduced ? 0 : 260));
  camImg.src = src; await camImg.decode().catch(() => {}); camImg.style.opacity = 1;
}
function clearInline() { for (const el of [cam, view]) { el.style.transform = ''; el.style.filter = ''; el.style.opacity = ''; el.style.transformOrigin = ''; } }
function scene(name) { body.dataset.scene = name; }

/* ================= home: one slow scroll through the Blender flight; each part appears only while you pass it ================= */
const film = $('#film'), fctx = film.getContext('2d', { alpha: false });
const FR = [], FSRC = i => `/assets/fly/f${String(i).padStart(4, '0')}.jpg`, LAST = 230;
const SECS = [[1, 30], [38, 84], [96, 136], [146, 186], [196, 230]];
let fShown = -1, fCur = 1, filmRaf = 0, filmLoading = false, filmDone = false, handedOff = false, autoRun = 0, activeSec = -1;
const FRAME_ORDER = [1, ...Array.from({ length: LAST }, (_, k) => k + 1).filter(i => i > 1 && i % 4 === 1),
  ...Array.from({ length: LAST }, (_, k) => k + 1).filter(i => i > 1 && i % 4 !== 1)];
function loadFrames() {
  if (filmLoading || filmDone) return;
  filmLoading = true;
  const load = i => {
    if (FR[i]) return Promise.resolve();
    const im = new Image(); im.src = FSRC(i);
    return im.decode().then(() => { FR[i] = im; if (i === 1 || Math.abs(i - fCur) < 3) drawFrame(fCur, true); }).catch(() => {});
  };
  (async () => {
    await load(1);
    const todo = FRAME_ORDER.filter(i => !FR[i]);
    for (let k = 0; k < todo.length; k += 4) {
      if (state.route !== 'home') { filmLoading = false; return; }
      await Promise.all(todo.slice(k, k + 4).map(load));
    }
    filmDone = true; filmLoading = false;
  })();
}
function sizeFilm() { const d = Math.min(devicePixelRatio, 1.5); film.width = Math.round(innerWidth * d); film.height = Math.round(innerHeight * d); fShown = -1; drawFrame(fCur, true); }
function nearestFrame(i) { for (let d = 0; d < LAST; d++) { if (FR[i - d]) return FR[i - d]; if (FR[i + d]) return FR[i + d]; } return null; }
function drawFrame(f, force = false) {
  const i = Math.round(f); if (i === fShown && !force) return;
  const im = FR[i] || nearestFrame(i); if (!im) return;
  const k = Math.max(film.width / im.width, film.height / im.height), w = im.width * k, h = im.height * k;
  fctx.drawImage(im, (film.width - w) / 2, (film.height - h) / 2, w, h);
  body.classList.add('film-ready');
  if (FR[i]) fShown = i;
}
addEventListener('resize', () => { if (state.route === 'home') sizeFilm(); if (state.route === 'reserve') paintPlan(); });
const homeMax = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
const homeProgress = () => Math.min(1, Math.max(0, scrollY / homeMax()));
const smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const secs = [...document.querySelectorAll('#home .sec')];
$('#rail').innerHTML = SECS.map((_, i) => `<button type="button" data-i="${i}" aria-label="Part ${i + 1}"></button>`).join('');
const railBtns = [...$('#rail').children];
railBtns.forEach(bt => bt.onclick = () => { const [a, b] = SECS[+bt.dataset.i]; scrollToFrame(bt.dataset.i === '0' ? 1 : (a + b) / 2, 1400); });
function filmLoop() {
  if (state.route !== 'home') { filmRaf = 0; return; }
  const p = homeProgress(), target = 1 + p * (LAST - 1);
  fCur += (target - fCur) * (reduced ? 1 : .06);
  drawFrame(fCur);
  let best = 0, bestV = -1, maxV = 0;
  SECS.forEach(([a, b], i) => {
    const w = (b - a) * .28, last = i === SECS.length - 1;
    const vin = i === 0 ? 1 : smooth((fCur - a) / w), vout = last ? 1 : smooth((b - fCur) / w), v = vin * vout;
    const el = secs[i]; el.style.opacity = v; el.style.transform = `translateY(${(1 - v) * (fCur < (a + b) / 2 ? 26 : -26)}px)`;
    el.classList.toggle('shown', v > .6);
    if (v > bestV) { bestV = v; best = i; } maxV = Math.max(maxV, v);
  });
  body.style.setProperty('--homeText', maxV);
  $('#homeCue').style.opacity = Math.max(0, 1 - p * 30);
  if (best !== activeSec && bestV > .55) { if (activeSec !== -1) fx.tick(); activeSec = best; railBtns.forEach((r, i) => r.classList.toggle('on', i === best)); }
  if (p > .992 && Math.abs(target - fCur) < 1.5 && !handedOff) { handedOff = true; fx.tick(2); handOff(); }
  filmRaf = requestAnimationFrame(filmLoop);
}
function startFilm() {
  handedOff = false; activeSec = -1; fCur = 1 + homeProgress() * (LAST - 1);
  loadFrames(); sizeFilm(); if (!filmRaf) filmRaf = requestAnimationFrame(filmLoop);
}
function handOff() { state.fromFilm = true; body.classList.add('from-film'); navigate(state.booking ? '/me' : '/reserve'); }
function scrollToFrame(f, ms) {
  cancelAnimationFrame(autoRun);
  const from = scrollY, to = (f - 1) / (LAST - 1) * homeMax(), t0 = performance.now(); ms = reduced ? 1 : ms;
  const step = n => { const t = Math.min(1, (n - t0) / ms); scrollTo(0, from + (to - from) * ease(t)); if (t < 1 && state.route === 'home') autoRun = requestAnimationFrame(step); };
  autoRun = requestAnimationFrame(step);
}
$('#homeCta').addEventListener('click', e => { e.preventDefault(); fx.tick(2); navigate(state.booking ? '/me' : '/reserve'); });
$('#deskBtn').addEventListener('click', e => { e.preventDefault(); navigate('/me'); });

/* ================= routing ================= */
const routeOf = p => p.startsWith('/me') || p.startsWith('/s/') ? 'me' : p.startsWith('/reserve') ? 'reserve' : p.startsWith('/profile') ? 'profile' : 'home';
function setPeek(on) {
  body.classList.toggle('peek', on);
  $('#peekBar').hidden = !on;
}
$('#peekClose').onclick = e => { e.stopPropagation(); setPeek(false); };
document.addEventListener('click', e => {
  if (!body.classList.contains('peek')) return;
  if (e.target.closest('#bar, #tabbar, #peekBar, dialog')) return;
  setPeek(false);
});
addEventListener('keydown', e => { if (e.key === 'Escape' && body.classList.contains('peek')) setPeek(false); });
function show(route) {
  state.route = route;
  if (!state.fromFilm) body.classList.remove('from-film');
  state.fromFilm = false;
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.dataset.view !== route;
  document.title = `Carrel · ${{ home: 'Home', reserve: 'Reserve a seat', me: 'My seat', profile: 'Profile' }[route]}`;
  setActive(route);
  setPeek(false);
  if (route !== 'reserve' && state.preview) resetPreview();
  scrollTo(0, 0);
  if (route === 'home') { clearInline(); scene('home'); setCam(FLY1); renderHome(); startFilm(); }
  if (route === 'reserve') { if (!state.preview) { clearInline(); scene('choose'); setCam(HALL); $('#choose').classList.remove('away'); $('#landing').hidden = true; } paintPlan(); requestAnimationFrame(() => floorSeg?.set(String(state.floor))); }
  if (route === 'me') renderMe();
  if (route === 'profile') { clearInline(); scene('profile'); setCam(SPOT); renderProfile(); }
}
function navigate(path, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  const r = routeOf(path);
  if (r === state.route) return show(r);
  transition(() => show(r));
}
addEventListener('popstate', () => show(routeOf(location.pathname)));
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-nav]'); if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault(); navigate(a.getAttribute('href'));
});

/* ================= home ================= */
function renderHome() {
  const h = +new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false });
  const first = (state.me?.name || '').split(' ')[0];
  $('#greet').textContent = `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}${first ? `, ${first}` : ''}`;
  const total = state.floors.reduce((a, f) => a + (f.counts.free || 0), 0);
  $('#homeFree').textContent = state.floors.length ? total : '—';
  $('#floorNums').innerHTML = state.floors.map(f => { const free = f.counts.free || 0, low = free / Math.max(1, f.total) < .3;
    return `<button type="button" data-f="${f.id}" class="${low ? 'low' : ''}"><b>${free}</b><span>Floor ${f.id} · ${esc(f.name)}${low ? ' · filling up' : ''}</span></button>`; }).join('');
  $('#floorNums').querySelectorAll('button').forEach(bt => bt.onclick = async () => {
    state.floor = +bt.dataset.f; floorSeg?.set(bt.dataset.f); renderFloorMeta(); await loadSeats(); navigate(`/reserve?floor=${bt.dataset.f}`); });
  const b = state.booking;
  $('#homeCta').textContent = b ? 'Go to my seat' : 'Choose a seat';
  $('#miniPass').hidden = !b; $('#deskBtn').hidden = !b;
  if (b) {
    $('#deskKick').textContent = 'Your seat'; $('#deskTitle').textContent = b.label;
    $('#deskText').textContent = { held: 'Reserved for you. Scan the QR on the desk to check in.', occupied: 'You are checked in.', break: 'You are on a break. Scan the desk when you are back.' }[b.status];
    $('#endKick').textContent = 'Your seat'; $('#endTitle').textContent = 'Back to your seat'; $('#endText').textContent = 'Keep scrolling to open your seat pass.';
  } else {
    $('#deskKick').textContent = 'How a seat becomes yours'; $('#deskTitle').textContent = 'Hold it, then scan the desk';
    $('#deskText').textContent = 'Reserve a free seat and it is kept for you for 10 minutes. Scan the QR on that desk to check in.';
    $('#endKick').textContent = 'Floor plan'; $('#endTitle').textContent = 'Choose your seat'; $('#endText').textContent = 'Keep scrolling to open the plan.';
  }
}

/* ================= reserve: plan ================= */
let floorSeg;
function renderFloorMeta() {
  if (!floorSeg) floorSeg = seg($('#floorSeg'), [['1', 'Floor 1'], ['2', 'Floor 2'], ['3', 'Floor 3']], String(state.floor), async v => {
    state.floor = +v; history.replaceState(null, '', `/reserve?floor=${v}`); renderFloorMeta(); await loadSeats(); });
  const f = state.floors.find(x => x.id === state.floor);
  if (f) $('#floorMeta').textContent = `${f.name} · ${f.counts.free || 0} free`;
}
let planSig = '';
function paintPlan(force = false) {
  if (state.route !== 'reserve') return;
  const portrait = innerWidth < 760;
  const sig = `${portrait ? 'P' : 'L'}|${state.floor}|${state.preview?.id || ''}|` + state.seats.map(s => `${s.id}:${s.status}:${s.mine ? 1 : 0}`).join(',');
  if (!force && sig === planSig && $('#plan').firstChild) return;
  planSig = sig;

  // Landscape on desktop (980×680) and rotated 90° portrait on phones (520×740) so all 129 seats fit edge-to-edge with zero scroll or zoom.
  const w = portrait ? 520 : 980, h = portrait ? 740 : 680;
  const s = portrait ? Math.min((w - 38) / 30.6, (h - 18) / 42.6) : Math.min((w - 22) / 42.6, (h - 42) / 31.4);
  const pt = (x, y) => portrait ? [w / 2 + (y - .5) * s, h / 2 - (x + .1) * s] : [w / 2 + (x + .1) * s, h / 2 - (y - .5) * s];
  const wRect = (x0, y0, x1, y1, rx, cls) => {
    const [ax, ay] = pt(x0, y0), [bx, by] = pt(x1, y1);
    const x = Math.min(ax, bx), y = Math.min(ay, by);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.abs(bx - ax).toFixed(1)}" height="${Math.abs(by - ay).toFixed(1)}" rx="${rx}" class="${cls}"/>`;
  };
  const g = [];
  // Architectural blueprint grid + warm window light wash
  const grad = portrait
    ? `<linearGradient id="winGlow" x1="1" y1="0" x2="0" y2="0"><stop offset="0%" stop-color="#FFEAD0" stop-opacity=".16"/><stop offset="100%" stop-color="#FFEAD0" stop-opacity="0"/></linearGradient>`
    : `<linearGradient id="winGlow" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FFEAD0" stop-opacity=".16"/><stop offset="100%" stop-color="#FFEAD0" stop-opacity="0"/></linearGradient>`;
  g.push(`<defs><pattern id="bpGrid" width="${(s * 2).toFixed(1)}" height="${(s * 2).toFixed(1)}" patternUnits="userSpaceOnUse"><path d="M ${(s * 2).toFixed(1)} 0 L 0 0 0 ${(s * 2).toFixed(1)}" fill="none" stroke="rgba(255,236,214,.045)" stroke-width="1"/></pattern>${grad}</defs>`);
  g.push(wRect(-21, -14.2, 20.8, 15.2, 18, 'grid'));
  g.push(wRect(-21, -14.2, 20.8, 15.2, 18, 'room'));
  g.push(wRect(-0.5, 11.2, 20.2, 15.1, 4, 'win-glow'));
  g.push(wRect(0, 15.05, 19.5, 15.35, 2, 'win'));

  // Entrance marker
  const [e1x, e1y] = pt(5.8, -14.2), [e2x, e2y] = pt(11.2, -14.2);
  g.push(`<line x1="${e1x.toFixed(1)}" y1="${e1y.toFixed(1)}" x2="${e2x.toFixed(1)}" y2="${e2y.toFixed(1)}" class="door"/>`);

  // Book stacks, reading tables (with T01–T16 labels), window carrels (C1–C9), lounge tables (L1–L6)
  for (let r = 0; r < 5; r++) for (let k = 0; k < 3; k++) {
    const cx = -19 + k * 4.4, cy = 3.2 + r * 2.4;
    g.push(wRect(cx - 1.6, cy - .31, cx + 1.6, cy + .31, 3, 'stack'));
  }
  const TCOLS = [-.5, 5.5, 11.5, 17.5], TROWS = [-4.5, 0, 4.5, 9];
  TCOLS.forEach((cx, ci) => TROWS.forEach((cy, ri) => {
    const tno = `T${String(ci * 4 + ri + 1).padStart(2, '0')}`;
    g.push(wRect(cx - 2.1, cy - .55, cx + 2.1, cy + .55, 5, 'tbl'));
    const [tx, ty] = pt(cx, cy);
    g.push(`<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" class="tnum" text-anchor="middle" dominant-baseline="central"${portrait ? ` transform="rotate(-90 ${tx.toFixed(1)} ${ty.toFixed(1)})"` : ''}>${tno}</text>`);
  }));
  // Row (R1–R4) and Column (Col 1–Col 4) axis markers along the reading-table grid
  TROWS.forEach((cy, ri) => {
    const [rx, ry] = pt(-3.55, cy);
    g.push(`<text x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" class="ax" text-anchor="middle" dominant-baseline="central">R${4 - ri}</text>`);
  });
  TCOLS.forEach((cx, ci) => {
    const [kx, ky] = pt(cx, -7.2);
    g.push(`<text x="${kx.toFixed(1)}" y="${ky.toFixed(1)}" class="ax" text-anchor="middle" dominant-baseline="central">C${ci + 1}</text>`);
  });
  for (let i = 0; i < 9; i++) {
    const cx = 1 + i * 2.1;
    g.push(wRect(cx - .8, 13.9, cx + .8, 14.6, 3, 'tbl'));
    const [kx, ky] = pt(cx, 14.25);
    g.push(`<text x="${kx.toFixed(1)}" y="${ky.toFixed(1)}" class="tnum" text-anchor="middle" dominant-baseline="central">C${i + 1}</text>`);
  }
  const LCOLS = [-18, -13, -8], LROWS = [-11.5, -6.5];
  LCOLS.forEach((cx, ci) => LROWS.forEach((cy, ri) => {
    const [lx, ly] = pt(cx, cy), lno = `L${ci * 2 + ri + 1}`;
    g.push(`<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="${(.95 * s).toFixed(1)}" class="tbl"/>`);
    g.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="tnum" text-anchor="middle" dominant-baseline="central">${lno}</text>`);
  }));

  // Minimal architectural zone labels tucked neatly along the walls
  if (portrait) {
    const [wx, wy] = pt(9.8, 16.0), [ex, ey] = pt(8.5, -15.1), [sx, sy] = pt(-15, 16.0), [lx, ly] = pt(-13, -15.1);
    g.push(`<text x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" class="lm" text-anchor="middle" transform="rotate(90 ${wx.toFixed(1)} ${wy.toFixed(1)})">Windows</text>`);
    g.push(`<text x="${ex.toFixed(1)}" y="${ey.toFixed(1)}" class="lm" text-anchor="middle" transform="rotate(-90 ${ex.toFixed(1)} ${ey.toFixed(1)})">Entrance</text>`);
    g.push(`<text x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" class="lm" text-anchor="middle" transform="rotate(90 ${sx.toFixed(1)} ${sy.toFixed(1)})">Stacks</text>`);
    g.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="lm" text-anchor="middle" transform="rotate(-90 ${lx.toFixed(1)} ${ly.toFixed(1)})">Lounge</text>`);
  } else {
    const [wx, wy] = pt(10, 15.85), [sx, sy] = pt(-14.6, 15.85), [lx, ly] = pt(-13, -15.25), [ex, ey] = pt(8.5, -15.25);
    g.push(`<text x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" class="lm" text-anchor="middle">Windows</text>`);
    g.push(`<text x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" class="lm" text-anchor="middle">Book stacks</text>`);
    g.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="lm" text-anchor="middle">Lounge</text>`);
    g.push(`<text x="${ex.toFixed(1)}" y="${ey.toFixed(1)}" class="lm" text-anchor="middle">Entrance</text>`);
  }

  // All 129 seats with crisp seat numbers + live HOLD pills rendered on top
  const c = portrait ? 14.5 : 18.5, tags = [];
  const seatNum = id => (String(id).match(/-S(\d+)$/)?.[1]) || (String(id).match(/-C(\d+)$/)?.[1]) || '';
  for (const st of state.seats) {
    const [x, y] = pt(st.x, st.y), pick = state.preview?.id === st.id;
    const cls = `seat ${st.status}${st.mine ? ' mine' : ''}${pick ? ' pick' : ''}`;
    const rot = (portrait ? (-st.face - 90) : -st.face) % 90;
    if (st.status === 'held') g.push(`<circle class="ring-held" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(c * .82).toFixed(1)}"/>`);
    if (st.mine) g.push(`<circle class="ring-mine" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(c * .95).toFixed(1)}"/>`);
    g.push(`<rect class="${cls}" data-id="${st.id}" data-status="${st.status}" x="${(x - c / 2).toFixed(1)}" y="${(y - c / 2).toFixed(1)}" width="${c}" height="${c}" rx="${(c * .3).toFixed(1)}"
      transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})" ${st.status === 'free' || st.mine ? 'tabindex="0" role="button"' : ''} aria-label="${esc(st.label)}, ${st.mine ? 'your seat' : WORD[st.status].toLowerCase()}"><title>${esc(st.label)} · ${st.mine ? 'Your seat' : WORD[st.status]}</title></rect>`);
    const nCls = pick ? 'snum on-pick' : st.status === 'held' ? 'snum on-held' : st.status === 'occupied' ? 'snum on-occ' : 'snum';
    g.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${nCls}" text-anchor="middle" dominant-baseline="central">${seatNum(st.id)}</text>`);
    if (st.status === 'held') {
      const left = st.expires_at ? Math.max(0, (new Date(st.expires_at) - now()) / 1000) : 0;
      const bw = 62, bh = 16;
      const bx = Math.max(bw / 2 + 6, Math.min(w - bw / 2 - 6, x));
      const above = y > 40;
      const by = above ? y - c / 2 - bh / 2 - 5 : y + c / 2 + bh / 2 + 5;
      tags.push(`<g class="hold-tag"><rect x="${(bx - bw / 2).toFixed(1)}" y="${(by - bh / 2).toFixed(1)}" width="${bw}" height="${bh}" rx="8"/><text data-hold="${st.id}" x="${bx.toFixed(1)}" y="${(by + 3).toFixed(1)}" text-anchor="middle">HOLD ${fmt(left)}</text></g>`);
    }
  }
  if (tags.length) g.push(...tags);
  $('#plan').innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="Floor plan, ${state.floor}">${g.join('')}</svg>`;
}
function pickFromPlan(e) {
  const r = e.target.closest('.seat'); if (!r) return;
  const st = state.seats.find(x => x.id === r.dataset.id); if (!st) return;
  if (st.mine) return navigate('/me');
  if (st.status === 'free') return go(st);
  const left = st.expires_at ? Math.max(0, (new Date(st.expires_at) - now()) / 1000) : 0;
  if (st.status === 'held') toast(`${st.label} is held · free in ${fmt(left)} if not checked in.`);
  else if (st.status === 'break') toast(`${st.label} is on a break · free in ${fmt(left)} if unclaimed.`);
  else toast(`${st.label} is taken.`);
}
$('#plan').addEventListener('click', pickFromPlan);
$('#plan').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFromPlan(e); } });

/* ================= reserve: camera push-in to the seat ================= */
const W = 1920, H = 1080;
const VIEWS = [
  { img: HALL, cam: [20.8, -1.0, 3.3], tgt: [-6, 6, 0.2], lens: 22 },
  { img: '/assets/views/entrance.jpg', cam: [7.5, -13.6, 1.7], tgt: [-14, 8, 1.3], lens: 24 },
  { img: '/assets/views/corner.jpg', cam: [21.0, 13.6, 3.4], tgt: [-4, -4, 0.2], lens: 22 },
];
const sub = (a, b) => a.map((x, i) => x - b[i]), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return a.map(x => x / l); }, dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const projector = V => { const f = norm(sub(V.tgt, V.cam)), r = norm(cross(f, [0, 0, 1])), u = cross(r, f), fx = V.lens / 36 * W;
  return p => { const d = sub(p, V.cam), z = dot(d, f); return z < .4 ? null : { x: W / 2 + dot(d, r) / z * fx, y: H / 2 - dot(d, u) / z * fx, z }; }; };
function bestView(p) {                                    // stay on the hall camera when it can see the seat; else the closest camera
  const h = projector(VIEWS[0])([p.x, p.y, .9]);
  if (h && h.x > 80 && h.x < W - 80 && h.y > 80 && h.y < H - 80) return { V: VIEWS[0], q: h };
  let best = null;
  for (const V of VIEWS) { const q = projector(V)([p.x, p.y, .9]); if (q && q.x > 160 && q.x < W - 160 && q.y > 120 && q.y < H - 120 && (!best || q.z < best.q.z)) best = { V, q }; }
  return best || { V: VIEWS[0], q: { x: W / 2, y: H * .6, z: 10 } };
}
const toScreen = q => { const sc = Math.max(innerWidth / W, innerHeight / H); return { x: innerWidth / 2 + (q.x - W / 2) * sc, y: innerHeight / 2 + (q.y - H / 2) * sc }; };

async function go(st) {
  if (state.busy) return; state.busy = true;
  body.classList.remove('from-film');
  state.preview = st; paintPlan();
  viewImg.src = seatViewSrc(st.id);
  $('#lFloor').textContent = floorLabel(state.floor);
  $('#lTitle').textContent = st.label;
  $('#lMeta').textContent = [ZONE[st.zone], ...(st.amenities || [])].filter(Boolean).join(' · ');
  $('#lErr').textContent = state.booking ? `You already have ${state.booking.label}. Leave it to switch seats.` : '';
  $('#durPicker').hidden = !!state.booking;
  syncDurUi();
  history.replaceState(null, '', `/reserve?floor=${state.floor}&seat=${encodeURIComponent(st.id)}`);
  await viewImg.decode().catch(() => {});
  // GPU-compositor-only zoom-in (transform + opacity only — zero per-frame blur repaints, zero 1-frame flash)
  $('#choose').classList.add('away');
  view.style.transition = 'none'; view.style.opacity = '0'; view.style.transform = 'scale(1.09) translate3d(0,0,0)';
  cam.style.transition = reduced ? 'none' : 'transform .65s var(--ease)';
  void view.offsetWidth;
  scene('landing'); body.classList.add('st-landing'); body.classList.remove('st-pass');
  cam.style.transform = 'scale(1.16) translate3d(0,0,0)';
  view.style.transition = reduced ? 'none' : 'opacity .52s var(--ease), transform .68s var(--ease)';
  view.style.opacity = '1'; view.style.transform = 'scale(1) translate3d(0,0,0)';
  $('#landing').hidden = false;
  centerDur(state.duration, false); updateWheel();
  requestAnimationFrame(() => $('#landing').classList.add('on'));
  await new Promise(r => setTimeout(r, reduced ? 1 : 540));
  view.style.transition = ''; view.style.opacity = ''; view.style.transform = '';
  cam.style.transition = ''; cam.style.transform = '';
  state.busy = false;
}
async function back() {
  if (state.busy) return; state.busy = true;
  $('#landing').classList.remove('on');
  view.style.transition = reduced ? 'none' : 'opacity .34s var(--ease), transform .38s var(--ease)';
  view.style.opacity = '0'; view.style.transform = 'scale(1.06) translate3d(0,0,0)';
  await new Promise(r => setTimeout(r, reduced ? 1 : 340));
  scene('choose'); resetPreview(); $('#choose').classList.remove('away');
  history.replaceState(null, '', `/reserve?floor=${state.floor}`);
  state.busy = false;
}
function resetPreview() {
  state.preview = null; $('#landing').hidden = true; $('#landing').classList.remove('on');
  cam.style.transition = ''; view.style.transition = ''; clearInline(); body.classList.remove('st-landing'); paintPlan();
}
$('#backBtn').onclick = back;

/* Apple-style tight cylindrical horizontal scroll wheel (3D perspective + micro ruler clicks + detent haptics) */
const durTrack = $('#durTrack'), durOpts = [...document.querySelectorAll('#durTrack .dur-opt')];
function syncDurUi() {
  const mins = state.duration;
  durOpts.forEach(o => o.setAttribute('aria-selected', String(+o.dataset.min === mins)));
  $('#durReadout').textContent = `${durLabel(mins)} · until ${clockTime(now() + mins * 60000)}`;
  $('#reserveBtn').textContent = state.booking ? 'Go to my seat' : `Reserve · ${durLabel(mins)}`;
  $('#reserveBtn').disabled = false;
}
function updateWheel() {
  if (!durTrack) return;
  const mid = durTrack.scrollLeft + durTrack.clientWidth / 2;
  for (const o of durOpts) {
    const off = (o.offsetLeft + o.offsetWidth / 2 - mid) / o.offsetWidth;      // -2 .. +2 stops from center
    const a = Math.min(2, Math.abs(off));
    const sc = Math.max(.74, 1.06 - a * .16);
    const op = Math.max(.26, 1 - a * .42);
    const ry = Math.max(-34, Math.min(34, -off * 18));
    o.style.transform = `scale(${sc.toFixed(3)}) rotateY(${ry.toFixed(1)}deg)`;
    o.style.opacity = op.toFixed(3);
  }
}
function centerDur(mins, smooth = true) {
  const el = durOpts.find(o => +o.dataset.min === mins); if (!el || !durTrack) return;
  const x = el.offsetLeft - (durTrack.clientWidth - el.offsetWidth) / 2;
  durTrack.scrollTo({ left: Math.max(0, x), behavior: smooth && !reduced ? 'smooth' : 'auto' });
  requestAnimationFrame(updateWheel);
}
let durScrollT = 0, lastMicroTick = -1;
durTrack?.addEventListener('scroll', () => {
  updateWheel();
  const mid = durTrack.scrollLeft + durTrack.clientWidth / 2;
  const micro = Math.round(durTrack.scrollLeft / 12.4);                       // 5 calibrated ruler ticks per 62px stop
  let best = durOpts[0], bestD = Infinity;
  for (const o of durOpts) { const d = Math.abs(o.offsetLeft + o.offsetWidth / 2 - mid); if (d < bestD) { bestD = d; best = o; } }
  const mins = +best.dataset.min;
  if (mins !== state.duration) { state.duration = mins; lastMicroTick = micro; fx.tick(1); syncDurUi(); }
  else if (micro !== lastMicroTick) { lastMicroTick = micro; fx.tick(.5); }   // crisp micro-click as ruler ticks glide past needle
}, { passive: true });
durTrack?.addEventListener('wheel', e => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); durTrack.scrollLeft += e.deltaY; }
}, { passive: false });
let dragDown = false, dragX = 0, dragLeft = 0, dragged = false, dragPid = null;
durTrack?.addEventListener('pointerdown', e => {
  if (e.pointerType === 'touch') return;
  dragDown = true; dragX = e.clientX; dragLeft = durTrack.scrollLeft; dragged = false; dragPid = e.pointerId;
});
durTrack?.addEventListener('pointermove', e => {
  if (!dragDown) return;
  const dx = e.clientX - dragX;
  if (!dragged && Math.abs(dx) > 6) {
    dragged = true; durTrack.classList.add('dragging');
    try { durTrack.setPointerCapture(dragPid); } catch {}
  }
  if (dragged) durTrack.scrollLeft = dragLeft - dx;
});
const endDrag = () => {
  if (!dragDown) return;
  dragDown = false;
  if (durTrack.classList.contains('dragging')) {
    durTrack.classList.remove('dragging');
    clearTimeout(durScrollT); durScrollT = setTimeout(() => centerDur(state.duration, true), 30);
  }
};
durTrack?.addEventListener('pointerup', endDrag);
durTrack?.addEventListener('pointercancel', endDrag);
durOpts.forEach(o => o.addEventListener('click', () => {
  if (dragged) { dragged = false; return; }
  state.duration = +o.dataset.min; fx.tick(); syncDurUi(); centerDur(state.duration, true);
}));

/* Reserve → the seat pass, as one morph: the title glides, the button becomes the timer ring, the view blurs */
$('#reserveBtn').onclick = async () => {
  if (state.booking) return navigate('/me');
  const st = state.preview; if (!st) return;
  const btn = $('#reserveBtn'); btn.disabled = true; state.reserving = true;
  try {
    await api('/api/book', { method: 'POST', body: { seat_id: st.id, duration_min: state.duration } });
    await loadMe();
    const t = transition(() => {
      history.pushState(null, '', '/me');
      state.route = 'me'; for (const el of document.querySelectorAll('.screen')) el.hidden = el.dataset.view !== 'me';
      $('#landing').hidden = true; state.preview = null; setActive('me');
      body.classList.replace('st-landing', 'st-pass'); renderMe(true);
    });
    await t.finished;
    loadSeats(); loadFloors();
  } catch (e) {
    $('#lErr').textContent = e.message;
    await loadSeats();
  } finally { btn.disabled = false; state.reserving = false; }
};

/* ================= my seat: the pass ================= */
let meKey = '';
function renderMe(rise = false) {
  const b = state.booking;
  $('#pass').hidden = !b; $('#empty').hidden = !!b;
  if (!b) {
    meKey = '';
    clearInline(); scene('empty'); setCam(SPOT); state.phase = null;
    $('#note').hidden = !state.note; $('#note').textContent = state.note;
    $('#foot') && ($('#foot').innerHTML = '');
    return;
  }
  const key = `${b.id}:${b.status}:${b.seat_id}`;
  const changed = key !== meKey || rise;
  if (!viewImg.getAttribute('src')?.endsWith(seatViewSrc(b.seat_id))) viewImg.src = seatViewSrc(b.seat_id);
  view.style.opacity = ''; view.style.transform = ''; view.style.filter = '';
  scene('pass');
  const st = b.status;
  if (state.phase?.status !== st) {
    const total = st === 'held' && b.created_at && b.expires_at ? (new Date(b.expires_at) - new Date(b.created_at)) / 1000
      : b.expires_at ? Math.max(1, (new Date(b.expires_at) - now()) / 1000) : 0;
    state.phase = { status: st, total };
  }
  $('#pMeta').textContent = [floorLabel(b.floor_id), zoneOf(b.seat_id)].filter(Boolean).join(' · ');
  if (changed) {
    meKey = key;
    $('#pState').textContent = { held: 'Reserved for you', occupied: 'Checked in', break: 'On a break' }[st];
    $('#pDot').className = st === 'occupied' ? 'ok' : '';
    $('#pTitle').textContent = b.label;
    $('#ring').classList.toggle('ok', st === 'occupied');
    $('#clockSub').textContent = { held: 'to check in', occupied: 'left in session', break: 'left on your break' }[st];
    const P = { held: 'Scan the QR on your desk', occupied: 'Take a 20‑min break', break: "I'm back · scan the QR" }[st];
    $('#primary').textContent = P;
    $('#primary').onclick = () => st === 'occupied' ? act('break') : openScanner();
    // Single-click Cancel / Leave (no multi-tap confirmation); only rebuild when booking status changes
    $('#links').innerHTML = `<button type="button" data-a="peek">See your view</button><button type="button" class="dim" data-a="map">Show on map</button>` +
      (st === 'held' ? `<button type="button" class="danger" data-a="leave">Cancel reservation</button>`
                     : `<button type="button" class="danger" data-a="leave">Leave seat</button>`);
    $('#links').querySelectorAll('[data-a]').forEach(el => el.onclick = e => {
      e.stopPropagation();
      if (el.disabled) return;
      act(el.dataset.a, el);
    });
    const at = t => `<b class="num">${clockTime(t)}</b>`;
    const mins = Math.round((b.duration_s || 7200) / 60), sessEnd = b.checked_in_at ? new Date(new Date(b.checked_in_at).getTime() + (b.duration_s || 7200) * 1000) : null;
    $('#foot').innerHTML = st === 'held' ? `<span>Session <b>${durLabel(mins)}</b></span><span>Hold ends at ${at(b.expires_at)}</span><span>Breaks up to <b>20 min</b></span>`
      : st === 'break' ? `<span>Checked in at ${at(b.checked_in_at)}</span><span>Break ends at ${at(b.expires_at)}</span>`
      : `<span>Checked in at ${at(b.checked_in_at)}</span><span>Session <b>${durLabel(mins)}</b> · until ${at(sessEnd)}</span>`;
    const pass = $('#pass'); if (rise) { pass.classList.remove('rise'); void pass.offsetWidth; pass.classList.add('rise'); }
  }
  tick();
}
async function act(a, btn = null) {
  try {
    if (a === 'peek') {
      const b = state.booking;
      if (b && !viewImg.getAttribute('src')?.endsWith(seatViewSrc(b.seat_id))) viewImg.src = seatViewSrc(b.seat_id);
      await viewImg.decode().catch(() => {});
      view.style.filter = ''; view.style.opacity = ''; view.style.transform = '';
      setPeek(!body.classList.contains('peek'));
      return;
    }
    if (a === 'map') { const b = state.booking; state.floor = b.floor_id; floorSeg?.set(String(b.floor_id)); renderFloorMeta(); await loadSeats(); return navigate(`/reserve?floor=${b.floor_id}`); }
    if (a === 'break') { await api('/api/break', { method: 'POST' }); toast('Break started. You have 20 minutes.'); }
    if (a === 'leave') {
      if (state.leaving) return;
      state.leaving = true; state.leftAt = Date.now();
      if (btn) { btn.disabled = true; btn.textContent = 'Leaving…'; }
      try {
        await api('/api/leave', { method: 'POST' });
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'NO_ACTIVE_SEAT')) { state.leaving = false; if (btn) btn.disabled = false; throw e; }
      }
      state.booking = null; state.note = ''; meKey = '';
      setBookingDot(null);
      toast('Seat released. Thanks for freeing it up.');
      renderMe(true);
      state.leaving = false;
      loadSeats().catch(() => {}); loadFloors().catch(() => {});
      return;
    }
    await loadMe(); renderMe(true); loadSeats().catch(() => {}); loadFloors().catch(() => {});
  } catch (e) { toast(e.message, 3600); await loadMe().catch(() => {}); }
}
function tick() {
  const b = state.booking;
  if (b && state.route === 'home') {
    const live = b.status === 'occupied' ? Math.max(0, (now() - new Date(b.checked_in_at)) / 1000) : (new Date(b.expires_at) - now()) / 1000;
    $('#hClock').textContent = fmt(live); $('#hSub').textContent = { held: 'to check in', occupied: 'in your seat', break: 'left on your break' }[b.status];
  }
  if (state.route === 'reserve') {
    let expired = false;
    for (const el of document.querySelectorAll('#plan text[data-hold]')) {
      const st = state.seats.find(s => s.id === el.dataset.hold);
      if (!st || st.status !== 'held' || !st.expires_at) continue;
      const left = (new Date(st.expires_at) - now()) / 1000;
      el.textContent = `HOLD ${fmt(left)}`;
      if (left <= 0) expired = true;
    }
    if (expired && !tick.planBusy) { tick.planBusy = true; setTimeout(() => { loadSeats().catch(() => {}); loadFloors().catch(() => {}); tick.planBusy = false; }, 1200); }
    return;
  }
  if (!b || state.route !== 'me') return;
  const arc = $('#arc'), clock = $('#clock');
  if (b.status === 'occupied') {
    const dur = b.duration_s || 7200;
    const left = Math.max(0, (new Date(b.checked_in_at).getTime() + dur * 1000 - now()) / 1000);
    clock.textContent = left < 3600 ? fmt(left) : `${Math.floor(left / 3600)}:${String(Math.floor(left % 3600 / 60)).padStart(2, '0')}`;
    arc.style.strokeDashoffset = 628.3 * (1 - Math.max(0, Math.min(1, left / dur))); return;
  }
  const left = (new Date(b.expires_at) - now()) / 1000;
  clock.textContent = fmt(left);
  arc.style.strokeDashoffset = 628.3 * (1 - Math.max(0, Math.min(1, left / (state.phase?.total || 600))));
  if (left <= 0 && !tick.busy) { tick.busy = true; setTimeout(async () => { await loadMe().catch(() => {}); renderMe(); loadSeats().catch(() => {}); tick.busy = false; }, 1200); }
}

/* ================= QR: live camera, native photo snap (iPhone fallback), or paste link ================= */
let camStream = null, scanning = false, scanTimer = 0, jsqrMod = null;
function parseCode(text) {
  try { const u = new URL(text, location.origin); const m = u.pathname.match(/^\/s\/([^/]+)$/); return m ? { seat: decodeURIComponent(m[1]), k: u.searchParams.get('k') } : null; }
  catch { return null; }
}
async function loadJsQr() {
  if (!jsqrMod) { const m = await import('jsqr'); jsqrMod = typeof m.default === 'function' ? m.default : m.default?.default; }
  return jsqrMod;
}
async function openCameraStream() {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('NO_MEDIA'), { name: 'NotSupportedError' });
  const tries = [
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: { facingMode: 'environment' }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr;
  for (const c of tries) {
    try { return await navigator.mediaDevices.getUserMedia(c); }
    catch (e) { lastErr = e; if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') throw e; }
  }
  throw lastErr;
}
async function openScanner() {
  $('#scanErr').textContent = ''; $('#codeInput').value = ''; $('#camBox').hidden = false; $('#scanner').showModal();
  try {
    camStream = await openCameraStream();
    const v = $('#camVideo');
    v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    v.srcObject = camStream;
    await v.play().catch(() => {});
    scanning = true;
    const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    const jsqr = detector ? null : await loadJsQr();
    const cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
    const step = async () => {
      if (!scanning) return;
      let text = null;
      if (v.readyState >= 2 && v.videoWidth) {
        if (detector) { const codes = await detector.detect(v).catch(() => []); text = codes[0]?.rawValue; }
        else if (jsqr) {
          // Downscale to <= 640px so iPhone Safari decodes smoothly without freezing the UI
          const sc = Math.min(1, 640 / v.videoWidth);
          cv.width = Math.round(v.videoWidth * sc); cv.height = Math.round(v.videoHeight * sc);
          ctx.drawImage(v, 0, 0, cv.width, cv.height);
          text = jsqr(ctx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, { inversionAttempts: 'attemptBoth' })?.data;
        }
      }
      const c = text && parseCode(text);
      if (c) { closeScanner(); return handleDeskCode(c.seat, c.k); }
      scanTimer = setTimeout(step, 150);
    };
    step();
  } catch (e) {
    $('#camBox').hidden = true;
    const https = location.protocol === 'https:' || location.hostname === 'localhost';
    $('#scanErr').textContent = !https
      ? 'Live camera needs HTTPS. Tap "Take a photo of the QR" below, or scan with your iPhone Camera app.'
      : e?.name === 'NotAllowedError'
      ? 'Camera permission is blocked in this browser. Allow it in Safari settings, or tap "Take a photo of the QR" below.'
      : 'Live camera is unavailable in this browser view. Tap "Take a photo of the QR" below, or scan with your iPhone Camera app.';
  }
}
function closeScanner() { scanning = false; clearTimeout(scanTimer); camStream?.getTracks().forEach(t => t.stop()); camStream = null; if ($('#scanner').open) $('#scanner').close(); }
$('#scanClose').onclick = closeScanner;
$('#scanner').addEventListener('close', () => { scanning = false; clearTimeout(scanTimer); camStream?.getTracks().forEach(t => t.stop()); camStream = null; });
$('#qrPhotoBtn').onclick = () => { $('#qrPhoto').value = ''; $('#qrPhoto').click(); };
$('#qrPhoto').onchange = async e => {
  const file = e.target.files?.[0]; if (!file) return;
  $('#scanErr').textContent = 'Reading QR code…';
  try {
    const img = new Image(), url = URL.createObjectURL(file);
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    URL.revokeObjectURL(url);
    const sc = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.naturalWidth * sc); cv.height = Math.round(img.naturalHeight * sc);
    const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const jsqr = await loadJsQr();
    const res = jsqr?.(ctx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, { inversionAttempts: 'attemptBoth' });
    const c = res?.data && parseCode(res.data);
    if (!c) return void ($('#scanErr').textContent = 'Could not find a Carrel QR code in that photo. Try moving closer.');
    closeScanner(); handleDeskCode(c.seat, c.k);
  } catch { $('#scanErr').textContent = 'Could not read that photo. Try again or paste the link.'; }
};
$('#codeForm').onsubmit = e => {
  e.preventDefault();
  const c = parseCode($('#codeInput').value.trim());
  if (!c) return void ($('#scanErr').textContent = 'That is not a Carrel desk link.');
  closeScanner(); handleDeskCode(c.seat, c.k);
};
// Arriving from a desk QR (phone camera opens /s/<seat>?k=…) or the in-app scanner
async function handleDeskCode(seatId, k, { fresh = false } = {}) {
  try {
    if (!fresh) await loadMe();
    const b = state.booking, mineHere = b?.seat_id === seatId;
    if (b && !mineHere) { toast(`You already have ${b.label}. Leave it first to sit here.`, 4200); return navigate('/me', { replace: true }); }
    if (b?.status === 'occupied' && mineHere) { toast('You are already checked in here.'); return navigate('/me', { replace: true }); }
    const wasBreak = b?.status === 'break';
    await api(b ? '/api/checkin' : '/api/walkin', { method: 'POST', body: { seat_id: seatId, k } });
    await loadMe();
    toast(wasBreak ? 'Welcome back. The seat is yours again.' : `Checked in at ${seatName(seatId, false)}.`, 3600);
    navigate('/me', { replace: true }); renderMe(true); loadSeats().catch(() => {}); loadFloors().catch(() => {});
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'Could not check in. Try again.', 4200);
    navigate(state.booking ? '/me' : '/reserve', { replace: true });
  }
}

/* ================= profile ================= */
async function renderProfile() {
  const m = state.me || {};
  $('#prAvatar').textContent = (m.name || '?')[0].toUpperCase(); $('#prName').textContent = m.name || ''; $('#prReg').textContent = `${m.reg_no || ''} · Student`;
  try {
    const h = await api('/api/me/history');
    $('#stHours').textContent = `${(h.study_s / 3600).toFixed(h.study_s < 36000 ? 1 : 0)}h`; $('#stChecks').textContent = h.check_ins; $('#stNo').textContent = h.no_shows;
    const max = Math.max(1, ...h.week.map(d => d.secs)), days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const tot = h.week.reduce((a, d) => a + d.secs, 0), top = h.week.reduce((a, d) => d.secs > a.secs ? d : a, h.week[0]);
    $('#weekSum').textContent = tot ? `${(tot / 3600).toFixed(1)} hours in the library in the last 7 days · most on ${days[top.dow - 1]}` : 'No time in the library in the last 7 days yet.';
    $('#week').innerHTML = h.week.map(d => `<div class="${d.secs === max && tot ? 'max' : ''}"><em class="num">${(d.secs / 3600).toFixed(1)}h</em><i style="height:${Math.max(4, d.secs / max * 120)}px"></i><span>${days[d.dow - 1]}</span></div>`).join('');
    const STATUS = { held: 'Reserved', occupied: 'In your seat', break: 'On a break', completed: 'Completed', cancelled: 'Cancelled', released: 'Released' };
    $('#sessions').innerHTML = h.recent.length ? h.recent.map(r => {
      const live = ['held', 'occupied', 'break'].includes(r.status);
      const why = r.status === 'released' ? (r.checked_in_at ? 'Break ran out' : 'Not checked in in time') : STATUS[r.status];
      const dur = r.secs ? ` · ${Math.floor(r.secs / 3600)} h ${String(Math.floor(r.secs % 3600 / 60)).padStart(2, '0')} min` : '';
      const when = new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      return `<div class="row"><div><b>${esc(r.label)}</b><span class="cap">Floor ${r.floor_id} · ${when}${dur}</span></div><span class="st ${live ? 'live' : ''}">${why}</span></div>`;
    }).join('') : '<p class="meta" style="padding:16px 0">No sessions yet. Reserve a seat to get started.</p>';
  } catch (e) { $('#weekSum').textContent = e.message; }
}
$('#prOut').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.href = '/'; };

/* ================= live ================= */
let liveT;
function onSeat(ev) {
  const st = state.seats.find(x => x.id === ev.seat_id);
  if (st) { st.status = ev.status; st.expires_at = ev.expires_at; if (ev.status === 'free') st.mine = false; paintPlan(); }
  if (state.preview?.id === ev.seat_id && !state.booking && !state.reserving) {
    const gone = ev.status !== 'free';
    $('#lErr').textContent = gone ? 'Someone just took this seat. Go back and pick another.' : '';
    $('#reserveBtn').disabled = gone;
  }
  clearTimeout(liveT); liveT = setTimeout(loadFloors, 300);
  if (state.booking && ev.seat_id === state.booking.seat_id) loadMe();
}

/* ================= boot ================= */
$('#walkinScan')?.addEventListener('click', openScanner);
async function main() {
  const deep = location.pathname.match(/^\/s\/([^/]+)$/);
  const initial = routeOf(location.pathname);
  // Render the active view immediately (zero dead black frame!) while API calls load in parallel.
  if (!deep && initial === 'home') show('home');
  else if (!deep && initial === 'reserve') { renderFloorMeta(); show('reserve'); }
  const meP = loadMe();
  const floorsP = !deep ? loadFloors().catch(() => {}) : null;
  const seatsP = !deep ? loadSeats().catch(e => toast(e.message || 'Having trouble loading seats. Retrying…', 4000)) : null;
  await meP;
  if (!state.me) return;
  mountShell({ me: state.me, active: initial, booking: state.booking, onScan: openScanner,
    onNav: href => (['/home', '/reserve', '/me', '/profile'].includes(href) ? (navigate(href), true) : false) });
  if (deep) {
    // Scanned a desk QR: check in straight away without flashing "No seat yet" or waiting for floor plans.
    await handleDeskCode(decodeURIComponent(deep[1]), params.get('k'), { fresh: true });
    loadFloors().then(() => { renderFloorMeta(); return loadSeats(); }).catch(() => {});
  } else {
    await Promise.all([floorsP, seatsP]);
    if (initial !== 'reserve' && initial !== 'home') show(initial);
    else if (initial === 'home') renderHome();
    else if (params.get('seat')) { const st = state.seats.find(x => x.id === params.get('seat') && x.status === 'free'); if (st) go(st); }
  }
  live({ onSeat, poll: () => Promise.all([loadSeats(), loadFloors(), loadMe()]), onState: setLive });
  setInterval(tick, 250);
}
main();
