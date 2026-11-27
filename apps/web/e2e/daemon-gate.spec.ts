// Task 4.1 Verification Gate, against the real edge daemon (not the browser demo):
// pairs with the daemon on its virtual vehicles, live PIDs render with no console
// errors, the safety modal blocks until confirmed, unknown speed shows
// PRECONDITION_UNKNOWN, and a killed daemon shows "not running".
//
// The daemon is the debug build (`cargo test --workspace` or `cargo build -p
// edge-daemon`). The cloud API is stood in, but the pairing and lease tokens it
// hands the browser are real: issued by signing.py with a throwaway key that
// this run pins in the daemon.
import type { Page } from "@playwright/test";
import { CloudSigner, Daemon, daemonAvailable, wireVersions } from "./daemon";
import { expect, test, useStandIns } from "./fixtures";

const ORIGIN = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 3100)}`;

test.describe.configure({ mode: "serial" });
test.skip(!daemonAvailable() && !process.env.CI, "build the daemon first: cargo build -p edge-daemon");

let signer: CloudSigner;
let daemon: Daemon;

test.beforeAll(async () => {
  signer = new CloudSigner(ORIGIN);
  daemon = new Daemon(ORIGIN, signer.keys());
  await daemon.start();
});

test.afterAll(async () => {
  await daemon?.stop();
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) await info.attach("daemon.log", { body: daemon.log, contentType: "text/plain" });
});

function consoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()} (${m.location().url})`);
  });
  return errors;
}

/** Pairs through the cloud token, takes the workshop lease, connects a virtual vehicle in Active mode. */
async function pairAndConnect(page: Page, vehicle: RegExp) {
  await page.goto("/devices");
  await expect(page.getByText("Paired by")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("your sign-in")).toBeVisible();
  // The daemon can verify cloud leases, so the app installs the plan's lease.
  await expect(page.getByText("Lease: Workshop").first()).toBeVisible({ timeout: 20_000 });
  const active = page.getByRole("checkbox", { name: "Allow confirmed actions (Active mode)" });
  await expect(active).toBeEnabled();
  await active.check();
  await page.getByRole("listitem").filter({ hasText: vehicle }).getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/in Active \(confirmed actions allowed\) mode/)).toBeVisible({ timeout: 15_000 });
}

/** In-app navigation to the job (a reload would drop the adapter connection). */
async function openJob(page: Page) {
  await page.getByRole("link", { name: /vehicles & jobs/i }).first().click();
  await page.getByRole("link", { name: /2008 BMW 320i/ }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "2008 BMW 320i (E90)" })).toBeVisible();
}

/** Ticks the workshop checklist, so only the hold (and the live checks) stand between the user and the action. */
async function tickChecklist(page: Page) {
  for (const box of await page.getByRole("alertdialog").getByRole("checkbox").all()) await box.check();
}

async function hold(page: Page, ms: number) {
  const button = page.getByRole("alertdialog").getByRole("button", { name: /^hold to|keep holding/i });
  await button.hover();
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test("pairs with the daemon, streams live PIDs, and the safety modal blocks until confirmed", async ({ page, context }) => {
  await useStandIns(context, { edgeMode: "daemon", edge: signer });
  const errors = consoleErrors(page);

  await pairAndConnect(page, /Virtual: Ford Falcon BA/);
  await openJob(page);

  await test.step("live PIDs render", async () => {
    await page.getByRole("link", { name: "Live data" }).click();
    await expect(page.getByText(/PIDs? streaming from Virtual: Ford Falcon BA/)).toBeVisible({ timeout: 15_000 });
    for (const name of ["Engine speed", "MAF air flow", "Coolant temperature", "Intake air temperature"]) {
      await expect(page.getByText(name, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    }
    await expect(page.getByTestId("scope")).toBeVisible();
  });

  await test.step("the modal blocks until the hold completes", async () => {
    await page.getByRole("link", { name: "Overview" }).click();
    await page.getByRole("button", { name: /scan all modules|scan again/i }).click();
    await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Clear codes" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Vehicle stationary/)).toBeVisible();
    await tickChecklist(page);
    await expect(dialog.getByRole("button", { name: /^hold to clear/i })).toBeEnabled({ timeout: 10_000 });

    const before = daemon.audit().length;
    await hold(page, 600); // let go early
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(500);
    expect(daemon.audit().slice(before), "nothing reached the daemon before the hold completed").toEqual([]);

    await hold(page, 2_000);
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(page.getByText("Codes cleared")).toBeVisible({ timeout: 20_000 });
    const outcomes = daemon.audit().slice(before).map((e) => e.outcome);
    expect(outcomes).toContain("token_issued");
    expect(outcomes).toContain("allowed");
  });

  expect(errors).toEqual([]);
});

test("unknown vehicle speed shows PRECONDITION_UNKNOWN and confirming stays blocked", async ({ page, context }) => {
  // The same car with its road-speed PID dead (debug-only EDGE_SIM_FAULTS).
  await daemon.kill();
  await daemon.start({ EDGE_SIM_FAULTS: "no-road-speed" });
  await useStandIns(context, { edgeMode: "daemon", edge: signer });
  await pairAndConnect(page, /Virtual: Ford Falcon BA/);
  await openJob(page);
  await page.getByRole("button", { name: /scan all modules|scan again/i }).click();
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Clear codes" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("PRECONDITION_UNKNOWN")).toBeVisible();
  await expect(dialog.getByText(/road speed can.t be read/i)).toBeVisible();
  await tickChecklist(page);
  const button = dialog.getByRole("button", { name: /^hold to clear/i });
  await expect(button).toBeDisabled();
  const before = daemon.audit().length;
  await button.hover({ force: true });
  await page.mouse.down();
  await page.waitForTimeout(2_000);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  expect(daemon.audit().slice(before), "nothing reached the daemon").toEqual([]);

  await test.step("the daemon itself refuses with PRECONDITION_UNKNOWN", async () => {
    // Asked directly over a second connection from the app's origin, as a
    // client that skipped the modal would: the daemon fails closed on its own.
    const reply = await page.evaluate(
      async ({ token, versions }) => {
        const ws = new WebSocket("ws://127.0.0.1:8765");
        const next = () => new Promise<Record<string, unknown>>((ok) => ws.addEventListener("message", (e) => ok(JSON.parse(e.data)), { once: true }));
        const ask = async (msg: Record<string, unknown>) => {
          ws.send(JSON.stringify({ request_id: crypto.randomUUID().replace(/-/g, ""), ...msg }));
          for (;;) {
            const m = await next();
            if (m.request_id !== undefined) return m;
          }
        };
        await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
        const hello = await ask({ type: "HelloRequest", client_token: token, client_version: "0.0.0", protocol_version: versions.protocol, policy_version: versions.policy });
        if (hello.type !== "HelloResponse") return hello;
        const conn = await ask({ type: "ConnectRequest", adapter_id: "virtual-ford-falcon-ba", protocol: "AUTO", baud_rate: null, safety_mode: "ACTIVE_CONFIRMED" });
        if (conn.type !== "AdapterStatus") return conn;
        await new Promise((ok) => setTimeout(ok, 2_500)); // longer than any speed reading may be old
        const r = await ask({ type: "SafetyConfirmRequest", tx_id: 0x7e0, rx_id: 0x7e8, protocol: "OBD", service_id: 4, payload_hex: "04", user_ack_text: "Clear codes on PCM (Task 4.1 gate)" });
        ws.close();
        return r;
      },
      { token: signer.pairing(), versions: wireVersions() },
    );
    expect(reply, JSON.stringify(reply)).toMatchObject({ type: "ErrorResponse", code: "PRECONDITION_UNKNOWN" });
    expect(daemon.audit().at(-1)).toMatchObject({ outcome: "token_refused", code: "PRECONDITION_UNKNOWN" });
  });
});

test("a killed daemon shows not running, with the fix", async ({ page, context }) => {
  await useStandIns(context, { edgeMode: "daemon", edge: signer });
  await page.goto("/devices");
  await expect(page.getByText("Paired by")).toBeVisible({ timeout: 20_000 });
  await daemon.kill();
  await expect(page.getByText(/edge daemon is not running/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Start it with/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry now" })).toBeVisible();
});
