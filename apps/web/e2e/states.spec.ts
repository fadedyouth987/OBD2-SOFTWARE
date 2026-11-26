// A-DES-2: loading, empty, error and offline states render instead of blank pages.
import { expect, test, useStandIns } from "./fixtures";

test("jobs list shows an error with Retry when the API fails", async ({ page, context }) => {
  await useStandIns(context, { mode: "server_error" });
  await page.goto("/jobs");
  await expect(page.getByText("Couldn't load jobs")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  // A 500's server detail is never shown verbatim.
  await expect(page.getByText("Internal Server Error")).toHaveCount(0);
});

test("jobs list shows an empty state", async ({ page, context }) => {
  await useStandIns(context, { mode: "empty_jobs" });
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Vehicles & jobs" })).toBeVisible();
  await expect(page.getByRole("link", { name: /start a job/i }).first()).toBeVisible();
});

test("a job that can't load shows an error", async ({ page, context }) => {
  await useStandIns(context, { mode: "server_error" });
  await page.goto("/jobs/j1");
  await expect(page.getByText("Couldn't load this job")).toBeVisible();
});

test("offline: home explains the cloud is unreachable instead of going blank", async ({ page, context }) => {
  await useStandIns(context, { mode: "offline" });
  await page.goto("/home");
  await expect(page.getByText("Working offline")).toBeVisible();
  await expect(page.getByText("Can't load your workshop right now")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Devices", exact: true })).toBeVisible();
});

test("live data without a vehicle shows how to connect", async ({ page, context }) => {
  await useStandIns(context);
  await page.goto("/jobs/j1/live");
  await expect(page.getByText("No live data")).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect a device" })).toBeVisible();
});
