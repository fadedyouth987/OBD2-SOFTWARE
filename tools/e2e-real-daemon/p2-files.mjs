import { launch, shot, signup, apiCall, nav, connectAdapter, BASE, fail } from './lib.mjs';
const { browser, ctx, page, errors } = await launch();
const log = (...a) => console.log('•', ...a);
try {
  await signup(page, 'files');
  await nav(page, '/knowledge');
  await page.getByText('Included from the Pro plan').waitFor({ timeout: 15000 });
  await apiCall(page, '/api/v1/auth/dev-grant-plan', { tier: 'WORKSHOP' });
  await page.goto(BASE + '/knowledge');
  await page.getByText('Schematic pages this month').waitFor({ timeout: 20000 });
  await page.setInputFiles('#schematic-file', 'loom.pdf');
  await page.getByLabel('Title').fill('Falcon BA engine loom');
  const falcon = await page.getByLabel('Vehicle', { exact: true }).locator('option', { hasText: 'Falcon AU' }).first().getAttribute('value');
  await page.getByLabel('Vehicle', { exact: true }).selectOption(falcon);
  await page.getByRole('button', { name: 'Upload' }).click();
  await page.getByText('Falcon BA engine loom').waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  await shot(page, '40-knowledge-schematic-uploaded');
  const [tab] = await Promise.all([ctx.waitForEvent('page'), page.getByRole('button', { name: 'Open' }).first().click()]);
  await tab.waitForURL(/^blob:/, { timeout: 15000 });
  log('schematic opened in', tab.url().slice(0, 30));
  await tab.close();
  log('schematic uploaded and opened');
  // CAN Studio with a DBC saved to the workshop.
  await connectAdapter(page, 'virtual-ford-falcon-ba', { active: false });
  await nav(page, '/jobs/new');
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some((i) => i.value === '6FPAAAJGSW8B12345'), null, { timeout: 15000 });
  await page.getByRole('button', { name: /Start job/ }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]+/, { timeout: 20000 });
  const jobPath = new URL(page.url()).pathname;
  await nav(page, jobPath + '/can');
  await page.getByText('0x201').first().waitFor({ timeout: 20000 });
  await page.getByLabel('Load from this computer').setInputFiles('falcon.dbc');
  await page.getByText(/falcon.dbc: 1 message/).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Save to workshop' }).click();
  await page.getByText('Saved to your workshop.').waitFor({ timeout: 15000 });
  await page.getByText('0x201').first().click();
  await page.waitForTimeout(1500);
  await shot(page, '41-can-studio-dbc-saved-decoded');
  await nav(page, jobPath + '/modules');
  await page.getByText('Falcon BA engine loom').waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  await shot(page, '42-modules-schematics');
  log('dbc saved + decoded; modules shows schematics');
} catch (e) {
  fail(e.message.split('\n').slice(0, 6).join(' | '));
  await shot(page, 'zz-fail-files');
} finally {
  console.log('console errors:', errors.length ? errors.slice(0, 15) : 'none');
  await browser.close();
}
