// Login is the front door. A session already sends you past this page (server redirect).
import { api, live } from './api.js';
import { seatName } from './shell.js';

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const raw = params.get('next') || '';
const next = /^\/(?!\/)[\w\-/.?=&%]*$/.test(raw) ? raw : '';            // same-site paths only
let mode = 'in';
let role = next.startsWith('/admin') ? 'admin' : 'student';

// Arrived by scanning a desk QR while logged out
const scanned = next.match(/^\/s\/([^/?]+)/);
if (scanned) {
  role = 'student';
  $('#scanNote').hidden = false;
  $('#scanSeat').textContent = seatName(decodeURIComponent(scanned[1]));
  $('#headline').textContent = 'Sign in to check in';
  $('#sub').textContent = 'The seat is yours the moment you sign in.';
}

function placeRoleThumb() {
  const sw = $('#roleSwitch'), on = sw?.querySelector('[aria-pressed="true"]'), th = sw?.querySelector('.rthumb');
  if (!on || !th) return;
  th.style.width = `${on.offsetWidth}px`;
  th.style.transform = `translateX(${on.offsetLeft - 4}px)`;
}

function syncCopy() {
  const isAdmin = role === 'admin';
  $('#roleStudent').setAttribute('aria-pressed', String(!isAdmin));
  $('#roleAdmin').setAttribute('aria-pressed', String(isAdmin));
  $('#ltabs').hidden = isAdmin;
  $('#regLabel').textContent = isAdmin ? 'Staff ID' : 'Registration number';
  $('#demoQuick').textContent = isAdmin ? 'Continue with demo librarian' : 'Continue with demo student';
  if (isAdmin && mode === 'up') setMode('in');
  if (!scanned) {
    if (isAdmin) {
      $('#headline').textContent = 'Librarian access';
      $('#sub').textContent = 'Live floor occupancy, peak hours and desk QR codes.';
    } else {
      $('#headline').textContent = mode === 'up' ? 'Make an account' : 'Welcome back';
      $('#sub').textContent = mode === 'up' ? 'Use your name and LPU registration number.' : 'Use your LPU registration number.';
    }
  }
  placeRoleThumb();
}

function setMode(m) {
  mode = m;
  $('#tabIn').setAttribute('aria-selected', String(m === 'in'));
  $('#tabUp').setAttribute('aria-selected', String(m === 'up'));
  document.querySelectorAll('.up-only').forEach(el => { el.hidden = m !== 'up'; el.querySelector('input').required = m === 'up'; });
  $('#go').innerHTML = m === 'up' ? 'Create account <span aria-hidden="true">→</span>' : 'Continue <span aria-hidden="true">→</span>';
  $('input[name=password]').autocomplete = m === 'up' ? 'new-password' : 'current-password';
  $('#err').textContent = '';
  if (!scanned && role !== 'admin') {
    $('#headline').textContent = m === 'up' ? 'Make an account' : 'Welcome back';
    $('#sub').textContent = m === 'up' ? 'Use your name and LPU registration number.' : 'Use your LPU registration number.';
  }
}

$('#roleStudent').onclick = () => { role = 'student'; $('#err').textContent = ''; syncCopy(); };
$('#roleAdmin').onclick = () => { role = 'admin'; $('#err').textContent = ''; syncCopy(); };
$('#tabIn').onclick = () => setMode('in');
$('#tabUp').onclick = () => setMode('up');
$('#pwEye').onclick = () => {
  const i = $('input[name=password]'), show = i.type === 'password';
  i.type = show ? 'text' : 'password'; $('#pwEye').setAttribute('aria-pressed', String(show)); $('#pwEye').textContent = show ? 'Hide' : 'Show';
  $('#pwEye').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
};

async function submit(body) {
  const go = $('#go'); go.disabled = true; $('#err').textContent = ''; go.style.opacity = .7;
  try {
    const r = await api(mode === 'up' ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body });
    location.href = next || (r.user.role === 'admin' ? '/admin' : '/home');
  } catch (e) { $('#err').textContent = e.message; go.disabled = false; go.style.opacity = ''; }
}
$('#form').onsubmit = e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  if (!/^\d{8}$/.test(f.reg_no || '')) return void ($('#err').textContent = role === 'admin' ? 'Enter your 8-digit staff ID.' : 'Enter your 8-digit registration number.');
  if ((f.password || '').length < 8) return void ($('#err').textContent = 'Password must be at least 8 characters.');
  if (mode === 'up' && (f.name || '').trim().length < 2) return void ($('#err').textContent = 'Enter your name.');
  submit(f);
};

// Demo accounts exist only in demo mode; the server sends their logins then and only then (none in production).
let DEMO = null;
$('#demoQuick').onclick = () => {
  const d = DEMO?.[role]; if (!d) return;
  setMode('in');
  $('input[name=reg_no]').value = d.reg_no;
  $('input[name=password]').value = d.password;
  submit({ reg_no: d.reg_no, password: d.password });
};

async function refresh() {
  try { const { floors } = await api('/api/floors'); $('#freeNow').textContent = floors.reduce((a, x) => a + (x.counts.free || 0), 0); } catch {}
}
(async () => {
  syncCopy();
  requestAnimationFrame(placeRoleThumb);
  addEventListener('resize', placeRoleThumb);
  try { const me = await api('/api/me'); if (me.user) return void (location.href = next || (me.user.role === 'admin' ? '/admin' : '/home')); DEMO = me.demo_logins || null; $('#demo').hidden = !DEMO; } catch {}
  refresh();
  let t; live({ onSeat: () => { clearTimeout(t); t = setTimeout(refresh, 300); }, poll: refresh });
})();
if (matchMedia('(pointer: fine)').matches) $('input[name=reg_no]').focus({ preventScroll: true });
