// A-DES-1: Connect → Identify → Auto-scan → Session overview → Live data / CAN Studio / Copilot.
import { connectDemoCar, expect, test, useStandIns } from "./fixtures";

test("vehicle session flow with the demo car", async ({ page, context }) => {
  await useStandIns(context);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await connectDemoCar(page);
  await page.getByRole("link", { name: /vehicles & jobs/i }).first().click();
  await page.getByRole("link", { name: /2008 BMW 320i/ }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "2008 BMW 320i (E90)" })).toBeVisible();

  await page.getByRole("button", { name: /scan all modules|scan again/i }).click();
  await expect(page.getByText(/scanned/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("P0301").first()).toBeVisible();
  await expect(page.getByText("Odometer mismatch between KOMBI and DME")).toBeVisible();

  await page.getByRole("link", { name: "Live data" }).click();
  await expect(page.getByText("Engine RPM").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/PIDs? streaming from/)).toBeVisible();

  await page.getByRole("link", { name: "CAN Studio" }).click();
  await expect(page.getByText("Live traffic")).toBeVisible();

  await page.getByRole("link", { name: "AI Copilot" }).click();
  await expect(page.getByText("Root cause analysis")).toBeVisible();
  expect(errors).toEqual([]);
});
