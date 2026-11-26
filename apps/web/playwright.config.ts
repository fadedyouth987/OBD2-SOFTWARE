import { defineConfig, devices } from "@playwright/test";

// End-to-end tests for the A-DES gates. They run against a production build
// (`pnpm build` first) with the cloud API stood in by route interception and
// the browser demo car in place of a daemon, so no infrastructure is needed.
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off", viewport: { width: 1366, height: 900 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 } } }],
  webServer: {
    command: `pnpm start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/signin`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
