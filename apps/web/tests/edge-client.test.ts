import { afterEach, describe, expect, it, vi } from "vitest";
import { browserSimTransport, BROWSER_SIM_ADAPTER_ID } from "@/lib/browser-sim";
import { EdgeClient, EdgeRequestError, type EdgeSnapshot, type TransportFactory } from "@/lib/edge-client";
import { parseObdDtcs } from "@/lib/diag";

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

let clients: EdgeClient[] = [];
afterEach(() => {
  clients.forEach((c) => c.stop());
  clients = [];
  vi.useRealTimers();
});

function make(transport: TransportFactory, credential: () => Promise<{ token: string; method: "cloud" | "code" | "sim" } | null>, helloTimeoutMs = 8000) {
  const c = new EdgeClient({ mode: "daemon", transport, clientVersion: "0.2.0", credential, onSnapshot: () => undefined, helloTimeoutMs });
  clients.push(c);
  return c;
}

describe("EdgeClient with the browser demo", () => {
  it("is ready only after HelloResponse, then answers requests", async () => {
    const c = make(browserSimTransport(), async () => ({ token: "demo", method: "sim" }));
    c.start();
    const s = await waitFor(c, (x) => x.phase === "ready");
    expect(s.hello?.lease_tier).toBe("COMMUNITY");
    const list = await c.request({ type: "AdapterListRequest" });
    expect(list.adapters[0].adapter_id).toBe(BROWSER_SIM_ADAPTER_ID);
    await c.request({ type: "ConnectRequest", adapter_id: BROWSER_SIM_ADAPTER_ID, protocol: "AUTO", baud_rate: null, safety_mode: "SILENT" });
    const r = await c.request({ type: "DiagCommandRequest", tx_id: 0x7e0, rx_id: 0x7e8, protocol: "OBD", service_id: 0x03, payload_hex: "03", safety_token: null });
    expect(parseObdDtcs(0x03, r.response_hex).map((d) => d.code)).toEqual(["P0171"]);
  });

  it("refuses gated actions and Active mode in the demo", async () => {
    const c = make(browserSimTransport(), async () => ({ token: "demo", method: "sim" }));
    c.start();
    await waitFor(c, (x) => x.phase === "ready");
    await expect(
      c.request({ type: "ConnectRequest", adapter_id: BROWSER_SIM_ADAPTER_ID, protocol: "AUTO", baud_rate: null, safety_mode: "ACTIVE_CONFIRMED" }),
    ).rejects.toMatchObject({ code: "LEASE_REQUIRED" });
    await c.request({ type: "ConnectRequest", adapter_id: BROWSER_SIM_ADAPTER_ID, protocol: "AUTO", baud_rate: null, safety_mode: "SILENT" });
    await expect(
      c.request({ type: "DiagCommandRequest", tx_id: 0x7e0, rx_id: 0x7e8, protocol: "OBD", service_id: 0x04, payload_hex: "04", safety_token: null }),
    ).rejects.toMatchObject({ code: "SAFETY_BLOCKED" });
  });

  it("rejects requests before it is ready", async () => {
    const c = make(browserSimTransport(), async () => ({ token: "demo", method: "sim" }));
    await expect(c.request({ type: "AdapterListRequest" })).rejects.toBeInstanceOf(EdgeRequestError);
  });
});

describe("EdgeClient failure handling", () => {
  it("asks for a pairing code when there is no credential", async () => {
    const c = make(browserSimTransport(), async () => null);
    c.start();
    const s = await waitFor(c, (x) => x.phase === "failed");
    expect(s.failure?.needsCode).toBe(true);
  });

  it("retries with backoff when the daemon isn't running", async () => {
    const closed: TransportFactory = (h) => {
      setTimeout(() => h.onClose(false), 0);
      return { send: () => undefined, close: () => undefined };
    };
    const c = make(closed, async () => ({ token: "jwt", method: "cloud" }));
    c.start();
    const s = await waitFor(c, (x) => x.phase === "waiting");
    expect(s.failure?.kind).toBe("unreachable");
    expect(s.retryInMs).toBe(1000);
  });

  it("says the browser blocked the connection when the socket can't even be created", async () => {
    const refused: TransportFactory = (h) => {
      setTimeout(() => h.onClose(false, true), 0);
      return { send: () => undefined, close: () => undefined };
    };
    const c = make(refused, async () => ({ token: "jwt", method: "cloud" }));
    c.start();
    const s = await waitFor(c, (x) => x.phase === "failed");
    expect(s.failure?.kind).toBe("blocked");
    expect(s.failure?.message).toMatch(/browser blocked/);
    expect(s.failure?.hint).toMatch(/local network access/);
  });

  it("tells a denied local-network permission apart from a daemon that isn't running", async () => {
    const closed: TransportFactory = (h) => {
      setTimeout(() => h.onClose(false), 0);
      return { send: () => undefined, close: () => undefined };
    };
    const opts = { mode: "daemon" as const, transport: closed, clientVersion: "0.2.0", onSnapshot: () => undefined };
    const cred = async () => ({ token: "jwt", method: "cloud" as const });
    const denied = new EdgeClient({ ...opts, credential: cred, localAccessBlocked: async () => true });
    const allowed = new EdgeClient({ ...opts, credential: cred, localAccessBlocked: async () => false });
    clients.push(denied, allowed);
    denied.start();
    allowed.start();
    expect((await waitFor(denied, (x) => x.phase === "failed")).failure?.kind).toBe("blocked");
    const s = await waitFor(allowed, (x) => x.phase === "waiting");
    expect(s.failure?.kind).toBe("unreachable");
    expect(s.failure?.message).toMatch(/not running/);
  });

  it("sends the credential and version in HelloRequest, and times out a silent handshake", async () => {
    const sent: string[] = [];
    const silent: TransportFactory = (h) => {
      setTimeout(() => h.onOpen(), 0);
      return { send: (t) => sent.push(t), close: () => undefined };
    };
    const c = make(silent, async () => ({ token: "123456", method: "code" }), 50);
    c.pairWithCode("123456");
    const s = await waitFor(c, (x) => x.phase === "waiting");
    const hello = JSON.parse(sent[0]);
    expect(hello).toMatchObject({ type: "HelloRequest", client_token: "123456", client_version: "0.2.0" });
    expect(s.failure?.message).toMatch(/never answered the handshake/);
  });

  it("maps an UNAUTHENTICATED reply to a pairing-code prompt", async () => {
    const reject: TransportFactory = (h) => {
      setTimeout(() => h.onOpen(), 0);
      return {
        send: (t) => {
          const { request_id } = JSON.parse(t);
          setTimeout(
            () =>
              h.onMessage(
                JSON.stringify({ type: "ErrorResponse", request_id, code: "UNAUTHENTICATED", message: "bad token", hint: "pair", detail_json: null }),
              ),
            0,
          );
        },
        close: () => undefined,
      };
    };
    const c = make(reject, async () => ({ token: "jwt", method: "cloud" }));
    c.start();
    const s = await waitFor(c, (x) => x.failure?.kind === "auth");
    expect(s.failure?.needsCode).toBe(true);
    expect(s.failure?.message).toMatch(/cloud sign-in/);
  });
});
