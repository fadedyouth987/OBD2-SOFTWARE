// A-DES-4: copilot cards show evidence and a confidence band, never a raw percentage.
import { expect, test, useStandIns } from "./fixtures";

test("copilot causes cite evidence with a confidence band", async ({ page, context }) => {
  await useStandIns(context);
  await page.goto("/jobs/j1/copilot");
  await expect(page.getByText("Failed crankcase ventilation valve")).toBeVisible();
  await expect(page.getByText(/HIGH confidence/)).toBeVisible();
  await expect(page.getByText(/MEDIUM confidence/)).toBeVisible();
  await expect(page.getByText(/node:ccv/).first()).toBeVisible();
  // Case IDs are shortened to 8 characters in the evidence line.
  await expect(page.getByText(/case case-001/).first()).toBeVisible();
  const causes = page.locator("main").filter({ hasText: "Root cause analysis" }).first();
  await expect(causes).not.toContainText(/\d+\s?%/);
});
