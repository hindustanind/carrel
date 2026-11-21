// End-to-end tests in real Chrome against a fresh database (see tests/e2e/server.js, 60× time scale).
import { test, expect } from '@playwright/test';
import { qrSig } from '../../server/auth.js';

const desk = seat => `/s/${seat}?k=${qrSig('e2e-qr', seat)}`;
const seat = (page, id) => page.locator(`.plan .seat[data-id="${id}"]`);
const nav = page => page.getByRole('navigation', { name: 'Main' }).first();
async function signIn(page, reg, pw) {
  await page.locator('input[name=reg_no]').fill(reg);
  await page.locator('input[name=password]').fill(pw);
  await page.locator('#go').click();
}
async function signInAt(page, path, reg, pw) {
  await page.goto(path);
  await signIn(page, reg, pw);
  await expect(page).not.toHaveURL(/\/(\?|$)/);                    // left the sign-in page
}
async function pickAndView(page, id) {                              // tap a seat → camera push-in → land in its view
  await seat(page, id).click();
  await expect(page.locator('#landing')).toHaveClass(/on/, { timeout: 8000 });
}

test('sign-in is the front door, with a live free-seat count', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Sign in/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.locator('#freeNow')).toHaveText(/^\d+$/);
  expect(Number(await page.locator('#freeNow').textContent())).toBeGreaterThan(300);
  await page.getByRole('tab', { name: 'New here' }).click();
  await expect(page.locator('input[name=name]')).toBeVisible();
  await page.getByRole('tab', { name: 'Sign in' }).click();
  await signIn(page, '12300002', 'wrong-password');
  await expect(page.locator('#err')).not.toBeEmpty();
  await page.goto('/reserve');                                      // pages after sign-in send you back here
  await expect(page).toHaveURL(/\/\?next=%2Freserve/);
});

test('signed-in student lands on Home, skips sign-in; role-based nav', async ({ page }) => {
  await signInAt(page, '/', '12300002', 'student-demo-2026');
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading', { name: 'Reserve a seat' })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/home$/);
  await expect(nav(page).getByRole('link', { name: 'Home' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Reserve' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'My seat' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/home$/);                          // students can't open the librarian pages
  await page.locator('#acctBtn').click();
  await page.getByRole('menuitem', { name: 'Profile' }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.locator('#prName')).toHaveText('Demo Student');
  await page.locator('#acctBtn').click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('student journey: home → plan → push-in → reserve morphs into the pass → peek → QR check-in → break → back → leave', async ({ page }) => {
  await signInAt(page, '/', '12300002', 'student-demo-2026');
  await page.locator('#homeCta').click();
  await expect(page).toHaveURL(/\/reserve/, { timeout: 10000 });
  await page.locator('#floorSeg button[data-v="2"]').click();
  await expect(seat(page, 'F2-T07-S3')).toHaveAttribute('data-status', 'free');
  await pickAndView(page, 'F2-T07-S3');
  await expect(page.locator('#lTitle')).toHaveText('Table 07 · Seat 3');
  await page.getByRole('button', { name: /^Reserve/ }).click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.locator('#pState')).toHaveText('Reserved for you');
  await expect(page.locator('#clock')).toHaveText(/^00:\d\d$/);       // 60× time scale: 10 min → 10 s

  await page.goto(desk('F2-T07-S3'));                                  // the phone camera opens the signed desk link
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.locator('#pState')).toHaveText('Checked in');

  await page.locator('#primary').click();                              // Take a 20-min break
  await expect(page.locator('#pState')).toHaveText('On a break');
  await page.locator('#primary').click();                              // I'm back · scan the QR → in-app scanner, paste the link
  await page.locator('#codeInput').fill(`http://localhost:8090${desk('F2-T07-S3')}`);
  await page.locator('#codeGo').click();
  await expect(page.locator('#pState')).toHaveText('Checked in');

  await page.getByRole('button', { name: 'See your view' }).click();
  await expect(page.locator('#peekClose')).toBeVisible();
  await page.locator('#peekClose').click();
  await expect(page.locator('#peekClose')).toBeHidden();

  await page.getByRole('button', { name: 'Leave seat' }).click();
  await expect(page.getByRole('heading', { name: 'No seat yet' })).toBeVisible();
  await nav(page).getByRole('link', { name: 'Reserve' }).click();
  await expect(seat(page, 'F2-T07-S3')).toHaveAttribute('data-status', 'free');
});

test('QR deep link while signed out: sign in with context, then checked in on My seat', async ({ page }) => {
  await page.goto(desk('F2-T05-S1'));
  await expect(page).toHaveURL(/\/\?next=/);
  await expect(page.locator('#scanNote')).toContainText('Floor 2 · Table 05 · Seat 1');
  await expect(page.getByRole('heading', { name: 'Sign in to check in' })).toBeVisible();
  await signIn(page, '12300003', 'judge-demo-2026');
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.locator('#pState')).toHaveText('Checked in');
  await expect(page.locator('#pTitle')).toHaveText('Table 05 · Seat 1');
  await page.getByRole('button', { name: 'See your view' }).click();
  await expect(page.locator('#peekClose')).toBeVisible();
  await page.locator('#peekClose').click();
  await expect(page.locator('#peekClose')).toBeHidden();

  await page.getByRole('button', { name: 'Leave seat' }).click();
  await expect(page.getByRole('heading', { name: 'No seat yet' })).toBeVisible();
});

test('forged desk code is refused', async ({ page }) => {
  await signInAt(page, '/', '12300003', 'judge-demo-2026');
  await page.goto('/s/F2-T01-S1?k=AAAAAAAAAAAAAAAA');
  await expect(page.locator('.toast')).toContainText('not a valid Carrel desk code');
});

test('live: another student sees the seat taken within 5 seconds', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const pa = await a.newPage(), pb = await b.newPage();
  await signInAt(pa, '/?next=%2Freserve%3Ffloor%3D3', '12300004', 'judge-demo-2026');
  await signInAt(pb, '/?next=%2Freserve%3Ffloor%3D3', '12300003', 'judge-demo-2026');
  await expect(seat(pb, 'F3-C4')).toHaveAttribute('data-status', 'free');
  await pickAndView(pa, 'F3-C4');
  const t0 = Date.now();
  await pa.getByRole('button', { name: /^Reserve/ }).click();
  await expect(seat(pb, 'F3-C4')).toHaveAttribute('data-status', 'held', { timeout: 5000 });
  expect(Date.now() - t0).toBeLessThan(5000);
  await pa.getByRole('button', { name: 'Cancel reservation' }).click();
  await expect(seat(pb, 'F3-C4')).toHaveAttribute('data-status', 'free', { timeout: 5000 });
  await a.close(); await b.close();
});

test('a hold that is never checked in comes back on its own, and My seat says why', async ({ page }) => {
  await signInAt(page, '/?next=%2Freserve%3Ffloor%3D1', '12300003', 'judge-demo-2026');
  await pickAndView(page, 'F1-L1-S1');
  await page.getByRole('button', { name: /^Reserve/ }).click();
  await expect(page.locator('#pState')).toHaveText('Reserved for you');
  await expect(page.locator('#note')).toContainText('ran out', { timeout: 20000 });
  await nav(page).getByRole('link', { name: 'Reserve' }).click();
  await page.locator('#floorSeg button[data-v="1"]').click();
  await expect(seat(page, 'F1-L1-S1')).toHaveAttribute('data-status', 'free');
});

test('librarian: one shell for dashboard, seats and desk QR', async ({ page }) => {
  await signInAt(page, '/', '12300001', 'admin-demo-2026');
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator('#kpis')).toContainText('Double bookings');
  await expect(page.locator('#kpis div').nth(4).locator('b')).toHaveText('0');
  await expect(page.locator('#heat i')).toHaveCount(7 * 24);
  await expect(nav(page).getByRole('link', { name: 'My seat' })).toHaveCount(0);
  await nav(page).getByRole('link', { name: 'Seats', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/seats$/);
  const [sheet] = await Promise.all([page.waitForEvent('popup'), page.getByRole('link', { name: 'Floor 1' }).click()]);
  await expect(sheet.locator('svg')).toHaveCount(129);
  await nav(page).getByRole('link', { name: 'Desk QR' }).click();
  await expect(page).toHaveURL(/\/admin\/desk/);
  await expect(page.locator('#qr svg')).toBeVisible();
  await expect(page.locator('#sWord')).toHaveText(/Free|Held|Taken|On a break/);
  await page.goto('/desk');                                          // old link still works
  await expect(page).toHaveURL(/\/admin\/desk/);
});

test('home: scrolling walks the camera through the five parts and hands off to the plan', async ({ page }) => {
  await signInAt(page, '/', '12300003', 'judge-demo-2026');
  await expect(page.locator('#homeTop')).toHaveCSS('opacity', '1');
  const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  await page.evaluate(y => scrollTo(0, y), Math.round(max * .26));       // "Three floors"
  await expect(page.locator('.sec[data-sec="1"]')).toHaveClass(/shown/, { timeout: 8000 });
  await expect(page.locator('#floorNums button')).toHaveCount(3);
  await page.evaluate(y => scrollTo(0, y), max);
  await expect(page).toHaveURL(/\/reserve/, { timeout: 15000 });
  await expect(page.locator('.plan .seat')).toHaveCount(129);
});

test('phone: sign-in, home, locked 2D plan and My seat fit with no sideways scrolling', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.goto('/'); await noOverflow();
  await signIn(page, '12300002', 'student-demo-2026');
  await expect(page).toHaveURL(/\/home$/); await noOverflow();
  await expect(page.locator('#tabbar')).toBeVisible();
  await page.locator('#tabbar').getByRole('link', { name: 'Reserve' }).click();
  await expect(page.locator('.plan .seat')).toHaveCount(129);
  await noOverflow();
  await page.locator('#tabbar').getByRole('link', { name: 'My seat' }).click();
  await expect(page).toHaveURL(/\/me$/); await noOverflow();
  await ctx.close();
});

