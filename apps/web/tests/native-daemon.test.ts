import { afterEach, describe, expect, it, vi } from "vitest";
import { EdgeClient, type EdgeSnapshot } from "@/lib/edge-client";
import { nativeDaemonKey } from "@/lib/native";
import { nativeDaemonTransport, phoneFailure, unpairedPhoneTransport, type NativeDaemonEvent } from "@/lib/native-daemon";
import { transportKey } from "@/context/edge";

type Sent = { type: string; id?: string; text?: string };

function stubApp(daemon?: object, extra: object = {}) {
  const sent: Sent[] = [];
  const win: Record<string, unknown> = {
    RootCauseNative: { platform: "android", appVersion: "0.3.0", daemon, ...extra },
    ReactNativeWebView: { postMessage: (m: string) => sent.push(JSON.parse(m)) },
  };
  vi.stubGlobal("window", win);
  const deliver = (events: NativeDaemonEvent[]) =>
    (win.RootCauseNativeDaemon as { deliver(e: NativeDaemonEvent[]): void }).deliver(events);
  return { sent, deliver };
}

function waitFor(client: EdgeClient, pred: (s: EdgeSnapshot) => boolean, ms = 2000): Promise<EdgeSnapshot> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (pred(client.snapshot)) {
        clearInterval(t);
        resolve(client.snapshot);
      } else if (Date.now() - start > ms) {
        clearInterval(t);
        reject(new Error(`timed out in phase ${client.snapshot.phase}`));
      }
    }, 5);
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));
let clients: EdgeClient[] = [];
afterEach(() => {
  clients.forEach((c) => c.stop());
  clients = [];
  vi.unstubAllGlobals();
});

function phoneClient(transport = nativeDaemonTransport()) {
  const c = new EdgeClient({
    mode: "daemon",
    transport,
    clientVersion: "0.3.0",
    credential: async () => ({ token: "jwt.from.cloud", method: "cloud" }),
    onSnapshot: () => undefined,
    phone: true,
  });
  clients.push(c);
  return c;
}

const PAIRED = { paired: true, name: "Bay 3 PC", host: "192.168.1.20", port: 8766, fingerprint: "ab12cd34ef560789" };

describe("the app's relayed connection to the workshop PC", () => {
  it("relays frames through the bridge and reaches ready with the technician's cloud token", async () => {
    const { sent, deliver } = stubApp(PAIRED);
    const c = phoneClient();
    c.start();
    await waitFor(c, () => sent.some((m) => m.type === "daemon-open"));
    const id = sent.find((m) => m.type === "daemon-open")!.id!;
    deliver([{ id, kind: "open" }]);
    await waitFor(c, () => sent.some((m) => m.type === "daemon-send"));
    const hello = JSON.parse(sent.find((m) => m.type === "daemon-send")!.text!);
    expect(hello.type).toBe("HelloRequest");
    // The phone authenticates exactly like the PC's browser: the cloud pairing token.
    expect(hello.client_token).toBe("jwt.from.cloud");
    deliver([
      {
        id,
        kind: "message",
        text: JSON.stringify({
          type: "HelloResponse",
          request_id: hello.request_id,
          daemon_version: "0.1.0",
          features: [],
          lease_tier: "PRO",
          policy_version: "1.0.0",
          protocol_version: "1.2.0",
          session_id: "s1",
        }),
      },
    ]);
    const s = await waitFor(c, (x) => x.phase === "ready");
    expect(s.hello?.lease_tier).toBe("PRO");
    c.stop();
    expect(sent.some((m) => m.type === "daemon-close" && m.id === id)).toBe(true);
  });

  it("ignores events for connections it doesn't know", async () => {
    const { deliver } = stubApp(PAIRED);
    nativeDaemonTransport();
    expect(() => deliver([{ id: "nope", kind: "open" }, null as never])).not.toThrow();
  });

  it("a removed phone fails with the reason and how to fix it, without asking for a code", async () => {
    const { sent, deliver } = stubApp(PAIRED);
    const c = phoneClient();
    c.start();
    await waitFor(c, () => sent.some((m) => m.type === "daemon-open"));
    const id = sent[0].id!;
    deliver([{ id, kind: "close", wasOpen: false, reason: "revoked" }]);
    const s = await waitFor(c, (x) => x.phase === "failed");
    expect(s.failure?.kind).toBe("phone");
    expect(s.failure?.needsCode).toBe(false);
    expect(s.failure?.message).toContain("Bay 3 PC no longer accepts this phone");
  });

  it("a certificate that doesn't match the pin is a hard failure", async () => {
    const { sent, deliver } = stubApp(PAIRED);
    const c = phoneClient();
    c.start();
    await waitFor(c, () => sent.length > 0);
    deliver([{ id: sent[0].id!, kind: "close", wasOpen: false, reason: "identity" }]);
    const s = await waitFor(c, (x) => x.phase === "failed");
    expect(s.failure?.message).toMatch(/didn't prove/);
  });

  it("an unreachable PC keeps retrying and says where it looked", async () => {
    const { sent, deliver } = stubApp(PAIRED);
    const c = phoneClient();
    c.start();
    await waitFor(c, () => sent.length > 0);
    deliver([{ id: sent[0].id!, kind: "close", wasOpen: false, reason: "unreachable" }]);
    const s = await waitFor(c, (x) => x.phase === "waiting");
    expect(s.failure?.kind).toBe("phone");
    expect(s.failure?.message).toBe("Can't reach Bay 3 PC at 192.168.1.20:8766.");
  });

  it("the daemon refusing the phone's Hello is a phone problem, not a pairing-code prompt", async () => {
    const { sent, deliver } = stubApp(PAIRED);
    const c = phoneClient();
    c.start();
    await waitFor(c, () => sent.length > 0);
    const id = sent[0].id!;
    deliver([{ id, kind: "open" }]);
    await waitFor(c, () => sent.some((m) => m.type === "daemon-send"));
    deliver([
      {
        id,
        kind: "message",
        text: JSON.stringify({
          type: "ErrorResponse",
          request_id: null,
          code: "LAN_UNAVAILABLE",
          message: "Phones must sign in with the RootCause app's cloud pairing.",
          hint: "x",
          detail_json: null,
        }),
      },
    ]);
    const s = await waitFor(c, (x) => x.phase === "failed" || x.phase === "waiting");
    expect(s.failure?.kind).toBe("phone");
    expect(s.failure?.needsCode).toBe(false);
  });

  it("an app with no PC paired explains how to pair, at once", async () => {
    stubApp({ paired: false });
    const c = phoneClient(unpairedPhoneTransport());
    c.start();
    const s = await waitFor(c, (x) => x.phase === "failed");
    expect(s.failure?.message).toMatch(/isn't paired with a workshop PC/);
    expect(s.failure?.hint).toMatch(/Pair a phone/);
  });

  it("an ordinary close after being connected is a plain reconnect", () => {
    expect(phoneFailure("closed")).toBeNull();
  });

  it("outside the app the relay fails cleanly", async () => {
    vi.stubGlobal("window", {});
    const c = phoneClient();
    c.start();
    await tick();
    const s = await waitFor(c, (x) => x.phase === "failed");
    expect(s.failure?.kind).toBe("phone");
  });
});

describe("choosing how to reach the daemon", () => {
  it("uses loopback in a browser and in older app versions", () => {
    vi.stubGlobal("window", {});
    expect(transportKey()).toBe("browser");
    stubApp(undefined);
    expect(transportKey()).toBe("app-legacy");
  });

  it("uses the paired PC in the app, and keys on its address and certificate", () => {
    stubApp(PAIRED);
    expect(transportKey()).toBe("phone:192.168.1.20:8766:ab12cd34ef560789");
    stubApp({ paired: false });
    expect(transportKey()).toBe("phone:unpaired");
    stubApp({ paired: false }, { devLoopback: true });
    expect(transportKey()).toBe("app-dev");
    stubApp(PAIRED, { devLoopback: true });
    expect(transportKey()).toMatch(/^phone:192/);
    expect(nativeDaemonKey(null)).toBe("browser");
  });
});
