import { chromium } from 'playwright';
import { launch, shot, signup, apiCall, nav, BASE, CHROME, fail } from './lib.mjs';
const { browser, page, errors } = await launch();
const log = (...a) => console.log('•', ...a);
try {
  await signup(page, 'team');
  // Community: one seat, invite is blocked with an upgrade path.
  await nav(page, '/workshop');
  await page.getByRole('heading', { name: 'Team' }).first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.getByText(/Workshop has 5 seats/).waitFor({ timeout: 15000 });
  await shot(page, '30-team-community-capped');
  log('community capped');
  await apiCall(page, '/api/v1/auth/dev-grant-plan', { tier: 'FLEET' });
  await page.goto(BASE + '/workshop');
  await page.getByText('Fleet plan').first().waitFor({ timeout: 20000 });
  await page.getByLabel('New site').fill('North yard');
  await page.getByRole('button', { name: 'Add site' }).click();
  await page.locator('section[aria-labelledby="team-sites"]').getByText('North yard', { exact: true }).waitFor();
  const email = `e2e-joiner-${Date.now().toString(36)}@example.com`;
  await page.locator('section[aria-labelledby="team-invite"]').getByLabel('Email').fill(email);
  await page.locator('section[aria-labelledby="team-invite"]').getByLabel('Role').selectOption('LEAD_TECH');
  await page.locator('section[aria-labelledby="team-invite"]').getByLabel('Site').selectOption({ label: 'North yard' });
  await page.getByRole('button', { name: 'Create invite' }).click();
  const linkBox = page.getByLabel('Invite link');
  await linkBox.waitFor({ timeout: 10000 });
  const link = await linkBox.inputValue();
  await shot(page, '31-team-invite-created');
  log('invite link', link.replace(/token=.*/, 'token=…'));
  // Invitee in a fresh browser profile.
  const b2 = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const p2 = await (await b2.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  p2.on('console', (m) => { if (m.type() === 'error') errors.push('[invitee] ' + m.text()); });
  await p2.goto(link.replace('http://localhost:3000', BASE));
  await p2.getByText(/invited to Bradley Auto E2E as a lead technician/).waitFor({ timeout: 15000 });
  await p2.getByLabel('Your name').fill('Sam Joiner');
  await p2.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await shot(p2, '32-join-invite-mobile');
  await p2.getByRole('button', { name: 'Create account and join' }).click();
  await p2.waitForURL(/\/home/, { timeout: 20000 });
  await p2.waitForTimeout(2000);
  await shot(p2, '33-joined-home-mobile');
  const reuse = await (await b2.newContext()).newPage();
  await reuse.goto(link.replace('http://localhost:3000', BASE));
  await reuse.getByText(/already been used/).waitFor({ timeout: 15000 });
  log('joined; link now single-use');
  await b2.close();
  await page.reload();
  await page.getByText('Sam Joiner').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  await shot(page, '34-team-two-members');
  log('owner sees new member');
} catch (e) {
  fail(e.message.split('\n').slice(0,6).join(' | '));
  await shot(page, 'zz-fail-team');
} finally {
  console.log('console errors:', errors.length ? errors.slice(0, 15) : 'none');
  await browser.close();
}
