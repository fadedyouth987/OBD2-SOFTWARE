import { chromium } from 'playwright';
export const BASE = process.env.E2E_WEB ?? 'http://127.0.0.1:3000';
export const API = process.env.E2E_API ?? 'http://127.0.0.1:8000';
export const SHOTS = process.env.E2E_SHOTS ?? new URL('./shots', import.meta.url).pathname;
export const CHROME = process.env.E2E_CHROME; // e.g. /usr/bin/google-chrome; default: Playwright's bundled Chromium
export async function launch() {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { browser, ctx, page, errors };
}
export const shot = (page, name, full = true) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
export async function token(page) { return page.evaluate(() => localStorage.getItem('rootcause.session')); }
export async function apiCall(page, path, body) {
  const t = await token(page);
  const r = await fetch(API + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}
export async function signup(page, tag) {
  const email = `e2e-${tag}-${Date.now().toString(36)}@example.com`;
  await page.goto(BASE + '/signup');
  await page.getByLabel('Your name').fill('Jack Tester');
  await page.getByLabel('Workshop name').fill('Bradley Auto E2E');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByRole('button', { name: /create/i }).click();
  await page.waitForURL(/\/home/, { timeout: 20000 });
  return email;
}
export async function connectAdapter(page, id, { active = false } = {}) {
  await page.goto(BASE + '/devices');
  await page.getByText(id, { exact: true }).waitFor({ timeout: 20000 });
  const row = page.locator('li', { has: page.getByText(id, { exact: true }) });
  if (await row.getByRole('button', { name: 'Disconnect' }).count()) {
    await row.getByRole('button', { name: 'Disconnect' }).click();
    await row.getByRole('button', { name: 'Connect' }).waitFor();
  }
  const box = page.getByLabel(/Active mode/i);
  if (await box.count()) { if (active) await box.check(); else await box.uncheck(); }
  await row.getByRole('button', { name: 'Connect' }).click();
  await row.getByRole('button', { name: 'Disconnect' }).waitFor({ timeout: 20000 });
}
// Client-side navigation keeps the daemon WebSocket (and adapter session) alive, like clicking links.
export async function nav(page, path) {
  await page.evaluate((p) => window.next.router.push(p), path);
  await page.waitForURL((u) => u.pathname + u.search === path || u.pathname === path.split('?')[0], { timeout: 15000 });
}
// Tick every checklist item in the safety dialog, then hold-to-confirm via the keyboard path.
export async function confirmGated(page) {
  const dlg = page.getByRole('alertdialog');
  await dlg.waitFor({ timeout: 15000 });
  for (const cb of await dlg.getByRole('checkbox').all()) await cb.check();
  const hold = dlg.getByRole('button', { name: /^(Hold|Keep holding)/ });
  await hold.waitFor();
  await page.waitForFunction((el) => !el.disabled, await hold.elementHandle(), { timeout: 10000 });
  await hold.focus();
  await page.keyboard.down('Space');
  await page.waitForTimeout(2000);
  await page.keyboard.up('Space');
}
