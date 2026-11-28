// Task 4.1 Verification Gate, against the real edge daemon (not the browser demo):
// pairs with the daemon on its virtual vehicles, live PIDs render with no console
// errors, the safety modal blocks until confirmed, unknown speed shows
// PRECONDITION_UNKNOWN, and a killed daemon shows "not running".
//
// The daemon is the debug build (`cargo test --workspace` or `cargo build -p
// edge-daemon`). The cloud API is stood in, but the pairing and lease tokens it
// hands the browser are real: issued by signing.py with a throwaway key that
// this run pins in the daemon.
import type { BrowserContext, Page } from "@playwright/test";
import { CloudSigner, DAEMON_PORT, Daemon, daemonAvailable, wireVersions } from "./daemon";
import { expect, test, useStandIns } from "./fixtures";
import { openPinned, type PinnedSocket } from "./pinned-ws";

const ORIGIN = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 3100)}`;

test.describe.configure({ mode: "serial" });
// `just e2e` builds the daemon first. A missing binary fails the gate rather than
// skipping it; set E2E_SKIP_DAEMON=1 to run the other suites without it.
test.skip(!!process.env.E2E_SKIP_DAEMON, "E2E_SKIP_DAEMON is set");

let signer: CloudSigner;
let daemon: Daemon;

test.beforeAll(async () => {
  if (!daemonAvailable()) throw new Error("no debug daemon: run `cargo build -p edge-daemon` (or `just e2e`), or set E2E_SKIP_DAEMON=1");
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
  // (The header chip on a computer; the daemon card's Lease row on a phone-sized screen.)
  await expect(
    page.getByText("Lease: Workshop").filter({ visible: true }).or(page.getByRole("definition").filter({ hasText: /^Workshop$/ })).first(),
  ).toBeVisible({ timeout: 20_000 });
  const active = page.getByRole("checkbox", { name: "Allow confirmed actions (Active mode)" });
  await expect(active).toBeEnabled();
  await active.check();
  await page.getByRole("listitem").filter({ hasText: vehicle }).getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/in Active \(confirmed actions allowed\) mode/)).toBeVisible({ timeout: 15_000 });
}

/** In-app navigation to the job (a reload would drop the adapter connection). */
async function openJob(page: Page) {
  // Phone-sized screens keep the navigation in the menu.
  const menu = page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("link", { name: /vehicles & jobs/i }).filter({ visible: true }).first().click();
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
    // Each lane auto-zooms, so its scale is printed beside it.
    await expect(page.getByTestId("scope").getByText(/^min .+ · max .+$/).first()).toBeVisible();
    // The daemon's INFO audit result ("VIN and odometer agree") belongs on the overview, not as a live banner.
    await expect(page.getByText(/VIN and odometer agree/)).toHaveCount(0);
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
      async ({ url, token, versions }) => {
        const ws = new WebSocket(url);
        // One listener for the whole exchange: replies are matched by request_id,
        // and the 20 Hz pushes in between are skipped, never lost or mistaken.
        const waiting = new Map<string, (m: Record<string, unknown>) => void>();
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(e.data);
          const done = typeof m.request_id === "string" ? waiting.get(m.request_id) : undefined;
          if (done) {
            waiting.delete(m.request_id);
            done(m);
          }
        });
        const ask = (msg: Record<string, unknown>) =>
          new Promise<Record<string, unknown>>((ok) => {
            const request_id = crypto.randomUUID().replace(/-/g, "");
            waiting.set(request_id, ok);
            ws.send(JSON.stringify({ request_id, ...msg }));
          });
        await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
        const hello = await ask({ type: "HelloRequest", client_token: token, client_version: "0.0.0", protocol_version: versions.protocol, policy_version: versions.policy });
        if (hello.type !== "HelloResponse") return hello;
        const conn = await ask({ type: "ConnectRequest", adapter_id: "virtual-ford-falcon-ba", protocol: "AUTO", baud_rate: null, safety_mode: "ACTIVE_CONFIRMED" });
        if (conn.type !== "AdapterStatus") return conn;
        // Asked at once: had the daemon seeded speed at connect, this would get a token.
        const r = await ask({ type: "SafetyConfirmRequest", tx_id: 0x7e0, rx_id: 0x7e8, protocol: "OBD", service_id: 4, payload_hex: "04", user_ack_text: "Clear codes on PCM (Task 4.1 gate)" });
        ws.close();
        return r;
      },
      { url: `ws://127.0.0.1:${DAEMON_PORT}`, token: signer.pairing(), versions: wireVersions() },
    );
    expect(reply, JSON.stringify(reply)).toMatchObject({ type: "ErrorResponse", code: "PRECONDITION_UNKNOWN" });
    expect(String(reply.message)).toMatch(/vehicle speed.*has not been read/);
    expect(daemon.audit().at(-1)).toMatchObject({ outcome: "token_refused", code: "PRECONDITION_UNKNOWN" });
  });
});

/**
 * The Android app, stood in: the web app in a phone-sized page with the app's
 * bridge (window.RootCauseNative + ReactNativeWebView), and the app's native
 * pinned-TLS link done in Node (./pinned-ws, as modules/daemon-link does).
 */
async function phoneApp(context: BrowserContext, pc: { name: string; host: string; port: number; fingerprint: string } | null, creds: () => string | null) {
  const sockets = new Map<string, PinnedSocket>();
  let page: Page | null = null;
  const deliver = (events: unknown[]) => {
    return void page?.evaluate((ev) => window.RootCauseNativeDaemon?.deliver(ev as never), events).catch(() => undefined);
  };
  await context.exposeBinding("__phoneBridge", (_src, raw: string) => {
    const m = JSON.parse(raw) as { type: string; id?: string; text?: string };
    if (m.type === "daemon-open" && m.id) {
      const id = m.id;
      const auth = creds();
      if (!pc || !auth) return deliver([{ id, kind: "close", wasOpen: false, reason: "unpaired" }]);
      sockets.set(
        id,
        openPinned({
          host: pc.host,
          port: pc.port,
          pin: pc.fingerprint,
          authorization: auth,
          origin: ORIGIN,
          onOpen: () => deliver([{ id, kind: "open" }]),
          onMessage: (text) => deliver([{ id, kind: "message", text }]),
          onClose: (wasOpen, reason, detail) => {
            sockets.delete(id);
            deliver([{ id, kind: "close", wasOpen, reason, detail }]);
          },
        }),
      );
    } else if (m.type === "daemon-send" && m.id) sockets.get(m.id)?.send(m.text ?? "");
    else if (m.type === "daemon-close" && m.id) {
      sockets.get(m.id)?.close();
      sockets.delete(m.id);
    }
  });
  await context.addInitScript((daemon) => {
    Object.defineProperty(window, "RootCauseNative", {
      value: Object.freeze({ platform: "android", appVersion: "0.2.0", daemon: Object.freeze(daemon) }),
    });
    Object.defineProperty(window, "ReactNativeWebView", {
      value: { postMessage: (m: string) => (window as unknown as { __phoneBridge(m: string): void }).__phoneBridge(m) },
    });
  }, pc ? { paired: true, name: pc.name, host: pc.host, port: pc.port, fingerprint: pc.fingerprint.slice(0, 16) } : { paired: false });
  page = await context.newPage();
  return { page, close: () => sockets.forEach((s) => s.close()) };
}

/** What the app does with a scanned code: one pinned connection, LanPairRequest, keep the credential. */
function pairPhone(link: string): Promise<{ pc: { name: string; host: string; port: number; fingerprint: string }; auth: string }> {
  const q = new URLSearchParams(link.slice("rootcause://lan-pair?".length));
  const pc = { name: q.get("n")!, host: q.get("h")!, port: Number(q.get("p")), fingerprint: q.get("fp")! };
  return new Promise((ok, fail) => {
    const s = openPinned({
      ...pc,
      pin: pc.fingerprint,
      authorization: `RootCause-Pair ${q.get("t")}`,
      origin: ORIGIN,
      onOpen: () => s.send(JSON.stringify({ type: "LanPairRequest", request_id: "pair_1", device_name: "Pixel 8", client_version: "0.2.0" })),
      onMessage: (text) => {
        const m = JSON.parse(text);
        s.close();
        if (m.type === "LanPairResponse") ok({ pc: { ...pc, name: m.daemon_name }, auth: `Bearer ${m.device_id}.${m.device_secret}` });
        else fail(new Error(text));
      },
      onClose: (_open, reason, detail) => fail(new Error(`pairing closed: ${reason} ${detail ?? ""}`)),
    });
  });
}

test("a phone pairs by QR code and clears codes through the PC's safety interlock over TLS", async ({ page, context, browser }) => {
  test.setTimeout(120_000);
  await daemon.kill();
  await daemon.start({ EDGE_LAN: "on", EDGE_LAN_BIND: "127.0.0.1", EDGE_LAN_HOST: "127.0.0.1", EDGE_LAN_PORT: "8766", EDGE_LAN_NAME: "Bay 3 PC" });
  await useStandIns(context, { edgeMode: "daemon", edge: signer });
  const phoneSize = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: false };

  await test.step("an unpaired phone says why it can't change the car", async () => {
    const ctx = await browser.newContext({ ...phoneSize, baseURL: ORIGIN });
    await useStandIns(ctx, { edgeMode: "daemon", edge: signer });
    const phone = await phoneApp(ctx, null, () => null);
    await phone.page.goto("/devices");
    await expect(phone.page.getByText(/isn't paired with a workshop PC/).first()).toBeVisible({ timeout: 20_000 });
    await expect(phone.page.getByRole("button", { name: "Pair with a PC" }).first()).toBeVisible();
    await ctx.close();
  });

  let link = "";
  await test.step("the PC shows a single-use pairing code", async () => {
    await page.goto("/devices");
    const card = page.locator("#phones");
    await expect(card.getByText("Bay 3 PC")).toBeVisible({ timeout: 20_000 });
    await card.getByRole("button", { name: "Pair a phone" }).click();
    await expect(card.getByRole("img", { name: /Pairing code for Bay 3 PC at 127.0.0.1:8766/ })).toBeVisible();
    await card.getByText("Can't scan? Show the pairing link").click();
    link = (await card.getByText(/^rootcause:\/\/lan-pair\?/).textContent()) ?? "";
    expect(link).toMatch(/^rootcause:\/\/lan-pair\?v=1&h=127\.0\.0\.1&p=8766&fp=[0-9a-f]{64}&t=/);
  });

  const paired = await pairPhone(link);
  await test.step("the code works once, and the PC lists the phone", async () => {
    await expect(pairPhone(link)).rejects.toThrow(/already used/);
    await expect(page.locator("#phones").getByText("Pixel 8 is paired")).toBeVisible({ timeout: 10_000 });
  });

  const ctx = await browser.newContext({ ...phoneSize, baseURL: ORIGIN });
  await useStandIns(ctx, { edgeMode: "daemon", edge: signer });
  const phone = await phoneApp(ctx, paired.pc, () => paired.auth);
  const p = phone.page;
  // A missing control fails fast with its name instead of eating the whole budget.
  p.setDefaultTimeout(20_000);
  page.setDefaultTimeout(20_000);
  try {
    await test.step("the phone connects through the PC with the technician's own lease", async () => {
      await p.goto("/devices");
      await expect(p.getByText("Workshop PC", { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(p.getByText("Bay 3 PC").first()).toBeVisible();
      await pairAndConnect(p, /Virtual: Ford Falcon BA/);
      // The PC's list shows the phone connected (it refreshes every 10 s).
      await expect(page.locator("#phones").getByText(/^\W*Connected$/)).toBeVisible({ timeout: 15_000 });
    });

    await test.step("clearing codes from the phone goes through the hold-to-confirm and the daemon's audit", async () => {
      await openJob(p);
      await p.getByRole("button", { name: /scan all modules|scan again/i }).click();
      await expect(p.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
      await p.getByRole("button", { name: "Clear codes" }).click();
      const dialog = p.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await tickChecklist(p);
      await expect(dialog.getByRole("button", { name: /^hold to clear/i })).toBeEnabled({ timeout: 10_000 });
      const before = daemon.audit().length;
      await hold(p, 2_000);
      await expect(p.getByText("Codes cleared")).toBeVisible({ timeout: 20_000 });
      const entries = daemon.audit().slice(before);
      expect(entries.map((e) => e.outcome)).toEqual(expect.arrayContaining(["token_issued", "allowed"]));
      for (const e of entries) {
        expect(e.client, JSON.stringify(e)).toMatch(/^lan:lan_[0-9a-f]{16} \(Pixel 8\)$/);
        expect(e.user).toBe("u1");
      }
    });

    await test.step("removing the phone on the PC cuts it off at once", async () => {
      const row = page.locator("#phones").getByRole("listitem").filter({ hasText: "Pixel 8" });
      await row.getByRole("button", { name: "Remove Pixel 8" }).click();
      await row.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(page.locator("#phones").getByText("No phones paired yet.")).toBeVisible();
      // The phone's top bar says at once that it can't change the car; Devices says why.
      await expect(p.getByRole("link", { name: /PC not connected/ })).toBeVisible({ timeout: 20_000 });
      await p.getByRole("link", { name: /PC not connected/ }).click();
      await expect(p.getByText(/Bay 3 PC no longer accepts this phone/).first()).toBeVisible();
    });
  } finally {
    phone.close();
    await ctx.close();
  }
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
