// Real-world check of the core promise: a student scans a desk QR on phone A, and phone B sees that seat taken.
//
//   node scripts/two-phone-check.js [baseUrl]          (default http://localhost:8080; try the Wi-Fi IP or tunnel URL)
//
// Three browsers: a laptop (admin) showing the Desk QR, phone A (iPhone, logged OUT, like a fresh camera scan)
// and phone B (Android, logged in, watching the floor plan). The QR is decoded from its pixels with jsQR,
// exactly what a phone camera sees, so a QR that points at an unreachable host fails this check.
import { chromium, devices } from '@playwright/test';
import jsQR from 'jsqr';

const BASE = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const ADMIN = ['12300001', 'admin-demo-2026'], A = ['12300004', 'judge-demo-2026'], B = ['12300003', 'judge-demo-2026'];
const ok = (m) => console.log(`  ✔ ${m}`), bad = (m) => { console.log(`  ✘ ${m}`); process.exitCode = 1; };
const t = () => performance.now();

const browser = await chromium.launch({ channel: 'chrome' });
const mk = (dev) => browser.newContext({ ...dev, baseURL: BASE });
const laptop = await mk({ viewport: { width: 1440, height: 900 } });
const phoneA = await mk(devices['iPhone 13']), phoneB = await mk(devices['Pixel 7']);

async function signIn(page, [reg, pw]) {
  await page.locator('input[name=reg_no]').fill(reg); await page.locator('input[name=password]').fill(pw);
  await page.locator('#go').click(); await page.waitForURL(u => u.pathname !== '/', { timeout: 15000 });
}
const api = (page, path, body) => page.evaluate(async ([p, b]) => {
  const r = await fetch(p, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : {});
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, body]);

try {
  console.log(`\nCarrel two-phone check against ${BASE}\n`);
  // 0. clean slate for the two test students
  for (const ctx of [phoneA, phoneB]) {
    const p = await ctx.newPage(); await p.goto('/'); await signIn(p, ctx === phoneA ? A : B);
    await api(p, '/api/leave', {}); await api(p, '/api/auth/logout', {}); await p.close();
  }

  // 1. laptop: admin opens the Desk QR for the next free seat
  const lp = await laptop.newPage(); await lp.goto('/'); await signIn(lp, ADMIN);
  await lp.goto('/admin/desk'); await lp.locator('#qr svg').waitFor();
  await lp.locator('#freeBtn').click(); await lp.waitForTimeout(600);
  const seatId = await lp.locator('#seatSel').inputValue();
  const qrPng = await lp.locator('#qr').screenshot();
  const url = await lp.evaluate(async (b64) => {                       // decode the QR *pixels*
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0);
    return JSON.stringify([...x.getImageData(0, 0, c.width, c.height).data, c.width, c.height]);
  }, qrPng.toString('base64')).then(s => { const a = JSON.parse(s), h = a.pop(), w = a.pop(); return jsQR(Uint8ClampedArray.from(a), w, h)?.data; });
  if (!url) throw new Error('could not decode the desk QR');
  ok(`desk QR for ${seatId} decodes to ${url}`);
  const host = new URL(url).hostname;
  if (/^(localhost|127\.)/.test(host) && !/localhost|127\./.test(BASE)) bad(`QR points at ${host}: a real phone could not open it`);
  const health = await fetch(new URL('/api/health', url)).then(r => r.ok).catch(() => false);
  health ? ok(`QR host answers (${new URL(url).origin})`) : bad(`QR host ${new URL(url).origin} is unreachable: a phone scan would fail`);

  // 2. phone B: logged in, watching the plan on that floor
  const pb = await phoneB.newPage();
  const pbLogs = []; pb.on('console', m => pbLogs.push(`con:${m.type()}:${m.text()}`)); pb.on('pageerror', e => pbLogs.push(`perr:${e.message}`));
  pb.on('response', r => { if (r.status() >= 400) pbLogs.push(`http:${r.status()}:${r.url()}`); });
  await pb.goto('/'); await signIn(pb, B);
  const floor = seatId.match(/^F(\d)/)[1];
  await pb.goto(`/reserve?floor=${floor}`);
  const pin = pb.locator(`.plan .seat[data-id="${seatId}"]`);
  try { await pin.waitFor({ state: 'attached', timeout: 15000 }); }
  catch (e) { throw new Error(`${e.message} | url=${pb.url()} seats=${await pb.locator('.plan .seat').count()} logs=${JSON.stringify(pbLogs)}`); }
  (await pin.getAttribute('data-status')) === 'free' ? ok(`phone B sees ${seatId} free`) : bad(`phone B sees ${seatId} as ${await pin.getAttribute('data-status')}`);
  const liveB = await pb.locator('#liveState').textContent().catch(() => '?');

  // 3. phone A: camera scan while logged out → sign in with context → checked in
  const pa = await phoneA.newPage(); await pa.goto(url.replace(new URL(url).origin, BASE));
  await pa.locator('#scanNote').waitFor({ timeout: 10000 });
  ok(`phone A (logged out) lands on sign-in with "${(await pa.locator('#scanNote').innerText()).replace(/\s+/g, ' ').trim()}"`);
  await pa.locator('input[name=reg_no]').fill(A[0]); await pa.locator('input[name=password]').fill(A[1]);
  const t0 = t(); await pa.locator('#go').click();
  await pa.locator('#pState').filter({ hasText: 'Checked in' }).waitFor({ timeout: 15000 });
  ok(`phone A checked in at ${await pa.locator('#pTitle').textContent()} (${Math.round(t() - t0)} ms)`);

  // 4. phone B and the laptop see it without reloading
  await pb.locator(`.plan .seat[data-id="${seatId}"][data-status="occupied"]`).waitFor({ state: 'attached', timeout: 6000 })
    .then(() => ok(`phone B shows ${seatId} Taken ${Math.round(t() - t0)} ms after phone A tapped Continue (stream: ${liveB})`))
    .catch(() => bad(`phone B still does not show ${seatId} taken after 6 s`));
  await lp.locator('#sWord').filter({ hasText: 'Taken' }).waitFor({ timeout: 6000 }).then(() => ok('laptop Desk QR flipped to Taken'), () => bad('laptop Desk QR did not flip'));

  // 5. phone B tries to take it anyway → refused by the server
  const steal = await api(pb, '/api/book', { seat_id: seatId });
  steal.status === 409 ? ok('phone B cannot book the taken seat (409)') : bad(`phone B booking returned ${steal.status}`);

  // 6. phone B goes offline (locked phone / lost Wi-Fi); phone A leaves; phone B comes back and catches up
  await phoneB.setOffline(true);
  await pa.getByRole('button', { name: 'Leave seat' }).click();
  await pa.getByRole('heading', { name: 'No seat yet' }).waitFor();
  await pb.waitForTimeout(1500); await phoneB.setOffline(false);
  await pb.evaluate(() => { dispatchEvent(new Event('online')); });
  await pb.locator(`.plan .seat[data-id="${seatId}"][data-status="free"]`).waitFor({ state: 'attached', timeout: 8000 })
    .then(() => ok('phone B caught up after being offline: seat free again'), () => bad('phone B missed the release while offline'));

  // 7. reverse: phone B reserves from the map, phone A (now on the plan) sees it held
  await pa.goto(`/reserve?floor=${floor}`);
  await pb.locator(`.plan .seat[data-id="${seatId}"]`).click();
  await pb.locator('#landing.on').waitFor({ timeout: 10000 });
  const t1 = t(); await pb.getByRole('button', { name: /Reserve/ }).click();
  await pa.locator(`.plan .seat[data-id="${seatId}"][data-status="held"]`).waitFor({ state: 'attached', timeout: 6000 })
    .then(() => ok(`phone A sees phone B's hold on ${seatId} in ${Math.round(t() - t1)} ms`), () => bad('phone A did not see the hold'));
  await api(pb, '/api/leave', {});
} catch (e) { bad(e.message); }
finally { await browser.close(); console.log(process.exitCode ? '\nFAILED\n' : '\nAll good.\n'); }
