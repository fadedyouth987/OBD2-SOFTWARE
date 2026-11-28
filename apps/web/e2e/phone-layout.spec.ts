// The Android app shows these same pages on a phone. Nothing may be wider than
// the screen: a card pushed wider by a table hid the job's Scan and Clear codes
// buttons off to the right, and a wide top bar pushed the safety dialog off screen.
import { connectDemoCar, expect, test, useStandIns } from "./fixtures";

// isMobile: like the app's web view, anything too wide widens the whole page
// (and with it full-screen dialogs such as the hold-to-confirm).
test.use({ viewport: { width: 412, height: 915 }, isMobile: true });

for (const path of ["/home", "/jobs/j1", "/jobs/j1/modules", "/devices"]) {
  test(`${path} fits a phone screen`, async ({ page, context }) => {
    await useStandIns(context);
    await connectDemoCar(page);
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    const tooWide = await page.evaluate(() =>
      [...document.querySelectorAll("main section")]
        .map((s) => ({ title: s.querySelector("h2")?.textContent ?? "?", right: s.getBoundingClientRect().right }))
        .filter((s) => s.right > window.innerWidth + 1),
    );
    expect(tooWide).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  });
}

test("the job's scan and clear buttons are on screen on a phone", async ({ page, context }) => {
  await useStandIns(context);
  await connectDemoCar(page);
  await page.goto("/jobs/j1");
  for (const name of [/scan all modules|scan again/i, /clear codes/i]) {
    const box = await page.getByRole("button", { name }).first().boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(412);
  }
});
