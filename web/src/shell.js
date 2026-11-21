// The shell shared by every page after login: header on the top gradient, role-based tabs, account menu, phone tab bar.
import { api } from './api.js';

export const TABS = {
  student: [{ id: 'home', href: '/home', label: 'Home' }, { id: 'reserve', href: '/reserve', label: 'Reserve' }, { id: 'me', href: '/me', label: 'My seat' }],
  admin: [{ id: 'dash', href: '/admin', label: 'Dashboard' }, { id: 'seats', href: '/admin/seats', label: 'Seats' },
          { id: 'desk', href: '/admin/desk', label: 'Desk QR' }, { id: 'reserve', href: '/reserve', label: 'Seat finder' }],
};

// "F1-T06-S1" → "Floor 1 · Table 06 · Seat 1" (works before any data has loaded)
export function seatName(id, withFloor = true) {
  const m = String(id || '').match(/^F(\d)-(.+)$/); if (!m) return id || '';
  const c = m[2]; let n = c, x;
  if ((x = c.match(/^T(\d+)-S(\d+)$/))) n = `Table ${x[1]} · Seat ${x[2]}`;
  else if ((x = c.match(/^C(\d+)$/))) n = `Window carrel ${x[1]}`;
  else if ((x = c.match(/^L(\d+)-S(\d+)$/))) n = `Lounge ${x[1]} · Seat ${x[2]}`;
  return withFloor ? `Floor ${m[1]} · ${n}` : n;
}
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Render the header into <header id="bar"> and the phone tabs into <nav id="tabbar">. */
export function mountShell({ me, active, onNav, onScan, booking }) {
  const role = me?.role === 'admin' ? 'admin' : 'student';
  const tabs = TABS[role], first = (me?.name || '?').trim().split(/\s+/)[0];
  const link = t => `<a href="${t.href}" data-tab="${t.id}" ${t.id === active ? 'aria-current="page"' : ''}>`;
  const bar = document.getElementById('bar');
  bar.className = 'bar on-scene';
  bar.innerHTML = `
    <a class="brand" href="${tabs[0].href}" aria-label="Carrel home"><span class="mark" aria-hidden="true"></span><span>Carrel</span></a>
    <nav class="nav" aria-label="Main">${tabs.map(t => `${link(t)}${t.label}${t.id === 'me' ? '<i class="dot" id="meDot" hidden></i>' : ''}</a>`).join('')}</nav>
    <span class="bar-sp"></span>
    <span class="live" id="liveState">Live</span>
    <div class="acct">
      <button class="acct-btn" id="acctBtn" aria-haspopup="menu" aria-expanded="false" aria-label="Account"><span class="avatar" aria-hidden="true">${esc(first[0]?.toUpperCase() || '?')}</span><span class="acct-name">${esc(first)}</span></button>
      <div class="menu" id="acctMenu" role="menu" hidden>
        <div class="who"><b>${esc(me?.name || '')}</b><span class="cap">${role === 'admin' ? 'Librarian' : 'Student'} · ${esc(me?.reg_no || '')}</span></div>
        ${role === 'student' ? '<a href="/profile" data-tab="profile" role="menuitem">Profile</a>' : ''}
        <button id="fxToggle" role="menuitemcheckbox" aria-checked="true">Sound &amp; haptics · On</button>
        <button id="logout" role="menuitem">Log out</button>
      </div>
    </div>`;
  const tb = document.getElementById('tabbar');
  if (tb) {
    tb.className = 'tabbar'; tb.setAttribute('aria-label', 'Main');
    if (onScan && role === 'student') {
      const scanBtn = `<button type="button" class="tab-scan" id="tabScan" aria-label="Scan desk QR"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.2"/></svg></button>`;
      const prof = { id: 'profile', href: '/profile', label: 'Profile' };
      tb.innerHTML = `${link(tabs[0])}${tabs[0].label}</a>${link(tabs[1])}${tabs[1].label}</a>${scanBtn}${link(tabs[2])}${tabs[2].label}</a>${link(prof)}${prof.label}</a>`;
      tb.querySelector('#tabScan')?.addEventListener('click', () => onScan());
    } else {
      tb.innerHTML = (role === 'admin' ? tabs.slice(0, 3) : tabs).map(t => `${link(t)}${t.label}</a>`).join('');
    }
  }
  document.querySelectorAll('#bar .brand, #bar .nav a, #tabbar a, #acctMenu a[data-tab]').forEach(a => a.addEventListener('click', e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (onNav?.(a.getAttribute('href'))) { e.preventDefault(); closeMenu(); }
  }));
  const btn = document.getElementById('acctBtn'), menu = document.getElementById('acctMenu');
  const closeMenu = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); };
  addEventListener('click', e => { if (!menu.contains(e.target)) closeMenu(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  const fxBtn = document.getElementById('fxToggle');
  const fxLabel = () => { fxBtn.textContent = `Sound & haptics · ${fx.on() ? 'On' : 'Off'}`; fxBtn.setAttribute('aria-checked', String(fx.on())); };
  fxLabel(); fxBtn.onclick = e => { e.stopPropagation(); fx.set(!fx.on()); fxLabel(); fx.tick(); };
  if (!mountShell.fxBound) { mountShell.fxBound = true;            // a light tick on every press of something you can act on
    document.addEventListener('pointerdown', e => { if (e.target.closest('.btn, .seg button, .nav a, .tabbar a, .tab-scan, .rail button, .floor-nums button, .links button, .plan .seat.free, .ltabs button')) fx.tick(); }, { passive: true }); }
  document.getElementById('logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.href = '/'; };
  setBookingDot(booking);
}
export function setActive(id) {
  document.querySelectorAll('#bar .nav a, #tabbar a').forEach(a => { if (a.dataset.tab === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}
export function setBookingDot(b) {
  const d = document.getElementById('meDot'); if (!d) return;
  d.hidden = !b; d.classList.toggle('amber', !!b && b.status !== 'occupied');
}
export function setLive(state) { const l = document.getElementById('liveState'); if (!l) return; l.classList.toggle('polling', state === 'polling'); l.textContent = state === 'polling' ? 'Reconnecting' : 'Live'; }

// Morph between states where the browser supports view transitions; plain swap elsewhere.
export const transition = fn => (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) ? document.startViewTransition(fn) : (fn(), { finished: Promise.resolve() });

// Segmented control with a sliding thumb (only the thumb moves; nothing re-renders).
export function seg(el, items, current, onPick) {
  el.classList.add('seg');
  el.innerHTML = `<span class="thumb" aria-hidden="true"></span>` + items.map(([v, label]) => `<button type="button" data-v="${v}" aria-pressed="${v === current}">${esc(label)}</button>`).join('');
  const place = () => { const on = el.querySelector('[aria-pressed="true"]'), th = el.querySelector('.thumb'); if (!on) return; th.style.width = `${on.offsetWidth}px`; th.style.transform = `translateX(${on.offsetLeft}px)`; };
  el.querySelectorAll('button').forEach(b => b.onclick = () => {
    el.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); place(); onPick(b.dataset.v);
  });
  requestAnimationFrame(place); addEventListener('resize', place);
  return { set(v) { el.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.v === String(v)))); place(); } };
}

/* ---------- feel: haptic tick + soft click, with an on/off setting ---------- */
const FX_KEY = 'carrel-fx';
let ac = null, sw = null;
export const fx = {
  on() { try { return localStorage.getItem(FX_KEY) !== 'off'; } catch { return true; } },
  set(v) { try { localStorage.setItem(FX_KEY, v ? 'on' : 'off'); } catch {} },
  tick(strength = 1) {
    if (!fx.on()) return;
    try { navigator.vibrate?.(strength >= 2 ? 16 : strength >= 1 ? 10 : 4); } catch {}  // Android
    try {                                                                                // iOS 18+ system haptic
      if (strength >= 1) {
        if (!sw) { const l = document.createElement('label'); l.setAttribute('aria-hidden', 'true'); l.style.cssText = 'position:fixed;left:-9px;top:0;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none';
          sw = document.createElement('input'); sw.type = 'checkbox'; sw.setAttribute('switch', ''); sw.tabIndex = -1; l.append(sw); document.body.append(l); sw._l = l; }
        sw._l.click();
      }
    } catch {}
    try {                                                                                // crisp mechanical detent click (Apple Crown / picker style)
      ac ||= new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
      o.type = 'triangle';
      const f0 = strength >= 2 ? 1400 : strength >= 1 ? 2600 : 3400;
      const f1 = strength >= 2 ? 420 : strength >= 1 ? 780 : 1400;
      const dur = strength >= 2 ? .028 : strength >= 1 ? .016 : .009;
      const amp = strength >= 2 ? .07 : strength >= 1 ? .05 : .022;
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(amp, t + .0015); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + .005);
    } catch {}
  },
};
