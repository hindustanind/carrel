// Click through the whole student flow in real Chrome and screenshot each step (laptop + phone). Reports console errors.
// node scripts/flow-shots.js <base> <outdir> <reg_no> <password>
import { chromium, devices } from '@playwright/test';
const [base = 'http://localhost:8080', out = '.', reg, pw] = process.argv.slice(2);
if (!reg || !pw) { console.error('usage: node scripts/flow-shots.js <base> <outdir> <reg_no> <password>'); process.exit(1); }
const browser = await chromium.launch({ channel: 'chrome' });
const errors = [];
for (const [size, opt] of [['laptop', { viewport: { width: 1440, height: 900 } }], ['phone', devices['iPhone 13']]]) {
  const ctx = await browser.newContext({ ...opt, baseURL: base });
  await ctx.request.post('/api/auth/login', { data: { reg_no: reg, password: pw } });
  await ctx.request.post('/api/leave', { data: {} });
  await ctx.clearCookies();
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${size} ${p.url()} ${e.message}`));
  p.on('console', m => m.type() === 'error' && errors.push(`${size} ${p.url()} ${m.text()}`));
  const shot = n => p.screenshot({ path: `${out}/${size}_${n}.png` });
  await p.goto('/'); await p.waitForTimeout(1600); await shot('01_login');
  await p.fill('input[name=reg_no]', reg); await p.fill('input[name=password]', pw); await p.click('#go');
  await p.waitForURL(/\/home$/); await p.waitForTimeout(1500); await shot('02_home');
  await p.click('#homeCta'); await p.waitForURL(/\/reserve/); await p.waitForTimeout(1400); await shot('03_choose');
  const free = await p.evaluate(() => { const r = [...document.querySelectorAll('.plan .seat.free')].find(e => /T0[5-8]-S/.test(e.dataset.id)); return r?.dataset.id; });
  await p.evaluate(id => document.querySelector(`.plan .seat[data-id="${id}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true })), free);
  await p.waitForTimeout(1000); await shot('04_pushin');
  await p.waitForSelector('#landing.on', { timeout: 8000 }); await p.waitForTimeout(500); await shot('05_landing');
  await p.click('#reserveBtn'); await p.waitForURL(/\/me$/); await p.waitForTimeout(1600); await shot('06_pass_held');
  const k = await ctx.request.get(`/api/admin/qr-link?seat=${free}`).then(r => r.ok() ? r.json() : null).catch(() => null);
  console.log(size, 'seat', free, k ? '' : '(no admin link; skipping QR check-in)');
  await p.goto('/profile'); await p.waitForTimeout(1500); await shot('07_profile');
  await p.goto('/me'); await p.waitForTimeout(800);
  await p.click('#links [data-a="leave"]'); await p.click('#links [data-a="leave"]'); await p.waitForTimeout(1500); await shot('08_empty');
  await ctx.close();
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
