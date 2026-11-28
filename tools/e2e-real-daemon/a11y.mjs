import AxeBuilder from '@axe-core/playwright';
import { writeFileSync } from 'node:fs';
import { launch, signup, apiCall, nav, connectAdapter, BASE, SHOTS, fail } from './lib.mjs';
const { browser, page, errors } = await launch();
const results = {};
async function audit(name) {
  await page.waitForTimeout(1500);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  results[name] = r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  if (r.violations.length) process.exitCode = 1; // WCAG violations fail the run (review L4)
  console.log(name.padEnd(28), r.violations.length ? r.violations.map((v) => `${v.id}(${v.nodes.length})`).join(', ') : 'clean');
}
try {
  await page.goto(BASE + '/signin'); await audit('signin');
  await page.goto(BASE + '/signup'); await audit('signup');
  await page.goto(BASE + '/join?token=not-a-real-token-xxxxxxxxxxxx'); await audit('join-invalid');
  await signup(page, 'a11y');
  await apiCall(page, '/api/v1/auth/dev-grant-plan', { tier: 'WORKSHOP' });
  await page.goto(BASE + '/home'); await page.getByText('Workshop plan').first().waitFor({ timeout: 20000 });
  await audit('home');
  await connectAdapter(page, 'virtual-ford-falcon-ba', { active: true });
  await audit('devices');
  await nav(page, '/jobs/new');
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some((i) => i.value === '6FPAAAJGSW8B12345'), null, { timeout: 15000 });
  await audit('jobs-new');
  await page.getByRole('button', { name: 'Start job and scan' }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]+\?scan=1/, { timeout: 20000 });
  await page.getByText('P0171').first().waitFor({ timeout: 30000 });
  const jobPath = new URL(page.url()).pathname;
  await audit('job-overview');
  await page.getByRole('button', { name: 'Clear codes' }).click();
  await page.getByRole('alertdialog').waitFor(); await audit('safety-modal');
  await page.keyboard.press('Escape');
  for (const t of ['live', 'modules', 'service', 'copilot', 'can', 'closeout']) { await nav(page, `${jobPath}/${t}`); await audit(`job-${t}`); }
  for (const p of ['/jobs', '/knowledge', '/key-programming', '/workshop', '/workshop/billing']) { await nav(page, p); await audit(p.slice(1).replace('/', '-')); }
  await page.goto(BASE + jobPath.replace('/jobs/', '/report/')); await audit('report');
} catch (e) {
  fail(e.message.split('\n').slice(0, 4).join(' | '));
} finally {
  writeFileSync(`${SHOTS}/a11y-report.json`, JSON.stringify(results, null, 2));
  console.log('console errors:', errors.length ? errors.slice(0, 10) : 'none');
  await browser.close();
}
