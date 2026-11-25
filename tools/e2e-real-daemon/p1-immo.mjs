// Needs IMMO_FEATURE_ENABLED=true on the local API. Sandbox ECU only (virtual-sandbox-immo).
import { launch, shot, signup, apiCall, connectAdapter, nav, confirmGated, BASE } from './lib.mjs';
const { browser, page, errors } = await launch();
const log = (...a) => console.log('•', ...a);
try {
  await signup(page, 'immo');
  await apiCall(page, '/api/v1/auth/dev-grant-plan', { tier: 'WORKSHOP', immo_entitled: true });
  await apiCall(page, '/api/v1/auth/dev-mark-aasra', {});
  await page.goto(BASE + '/key-programming');
  await page.getByText('Technician accreditation').waitFor({ timeout: 20000 });
  await shot(page, '50-immo-eligibility-enrol');
  await page.getByLabel('AASRA member ID').fill('AASRA-SBX-0001');
  await page.getByLabel('National police check date').fill(new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
  await page.locator('input[type=checkbox]').first().check();
  await page.getByRole('button', { name: 'Submit accreditation' }).click();
  await page.getByRole('button', { name: 'Read from vehicle' }).waitFor({ timeout: 20000 });
  log('eligible after enrol');
  await connectAdapter(page, 'virtual-sandbox-immo', { active: true });
  await nav(page, '/key-programming');
  await page.getByRole('button', { name: 'Read from vehicle' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some((i) => i.value === 'SBXTESTVAN0000001'), null, { timeout: 15000 });
  await shot(page, '51-immo-vehicle');
  await page.getByRole('button', { name: 'Continue' }).click();
  for (const cb of await page.locator('input[type=checkbox]').all()) await cb.check();
  await shot(page, '52-immo-owner-authorisation');
  await page.getByRole('button', { name: 'Record authorisation' }).click();
  await page.getByRole('button', { name: 'Start secure session' }).click();
  await page.getByRole('button', { name: /Learn key/ }).waitFor({ timeout: 30000 });
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((b) => /Learn key/.test(b.textContent))?.disabled, null, { timeout: 20000 });
  await shot(page, '53-immo-session-ready');
  log('secure session started');
  await page.getByRole('button', { name: /Learn key/ }).click();
  await confirmGated(page);
  await page.getByText(/accepted the new key/).waitFor({ timeout: 40000 });
  await shot(page, '54-immo-key-learned');
  log('key learned on sandbox ECU');
} catch (e) {
  console.log('FAIL', e.message.split('\n').slice(0, 5).join(' | '));
  await shot(page, 'zz-fail-immo');
} finally {
  console.log('console errors:', errors.length ? errors.slice(0, 10) : 'none');
  await browser.close();
}
