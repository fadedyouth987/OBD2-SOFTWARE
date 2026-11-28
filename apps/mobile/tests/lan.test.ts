import { cleanDeviceName, daemonUrl, parsePairingLink, type PairingLink } from "../src/lan/link";
import type { DaemonLinkLike, LinkEvents } from "../src/lan/native";
import { PairingError, pairWithPc } from "../src/lan/pair";
import { DaemonRelay, deliverScript, type RelayEvent } from "../src/lan/relay";
import { PC_KEY, PcStore, publicInfo, type PairedPc } from "../src/lan/store";
import { bootstrapScript, daemonUpdateScript, parseBridgeMessage } from "../src/web/bridge";

const FP = "ab".repeat(32);
const TOKEN = "A".repeat(43);
const LINK = `rootcause://lan-pair?v=1&h=192.168.1.20&p=8766&fp=${FP}&t=${TOKEN}&id=rcd_0011223344556677&n=Bay%203%20PC`;

class FakeLink implements DaemonLinkLike {
  calls: { op: string; args: unknown[] }[] = [];
  handlers = new Set<LinkEvents>();
  failConnect: Error | null = null;
  async connect(...args: [string, string, string, string, string]) {
    this.calls.push({ op: "connect", args });
    if (this.failConnect) throw this.failConnect;
  }
  async send(id: string, text: string) {
    this.calls.push({ op: "send", args: [id, text] });
    return true;
  }
  async close(id: string) {
    this.calls.push({ op: "close", args: [id] });
  }
  subscribe(h: LinkEvents) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  open(id: string) {
    this.handlers.forEach((h) => h.onOpen({ id }));
  }
  message(id: string, text: string) {
    this.handlers.forEach((h) => h.onMessage({ id, text }));
  }
  closed(id: string, reason: Parameters<LinkEvents["onClose"]>[0]["reason"], wasOpen = false) {
    this.handlers.forEach((h) => h.onClose({ id, wasOpen, reason }));
  }
  lastConnectId() {
    return [...this.calls].reverse().find((c) => c.op === "connect")!.args[0] as string;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the pairing link from the PC's QR code", () => {
  it("reads a link the daemon makes", () => {
    const r = parsePairingLink(LINK);
    expect(r).toEqual({
      ok: true,
      link: { host: "192.168.1.20", port: 8766, fingerprint: FP, token: TOKEN, daemonId: "rcd_0011223344556677", name: "Bay 3 PC" },
    });
    expect(daemonUrl("192.168.1.20", 8766)).toBe("wss://192.168.1.20:8766/");
  });

  it("accepts IPv6 and .local addresses", () => {
    const v6 = parsePairingLink(LINK.replace("h=192.168.1.20", "h=[fe80::1]"));
    expect(v6.ok && v6.link.host).toBe("[fe80::1]");
    expect(parsePairingLink(LINK.replace("h=192.168.1.20", "h=bay3.local")).ok).toBe(true);
  });

  it("refuses anything else before connecting anywhere", () => {
    const bad = [
      "https://evil.example/lan-pair?v=1",
      LINK.replace("v=1", "v=2"),
      LINK.replace("h=192.168.1.20", "h=evil.example.com"),
      LINK.replace("h=192.168.1.20", "h=999.1.1.1"),
      LINK.replace("p=8766", "p=70000"),
      LINK.replace(`fp=${FP}`, "fp=abc"),
      LINK.replace(`fp=${FP}`, `fp=${FP.toUpperCase()}`),
      LINK.replace(`t=${TOKEN}`, "t=short"),
      LINK.replace("id=rcd_0011223344556677", "id=x"),
      LINK + "&pad=" + "x".repeat(600),
    ];
    for (const b of bad) expect(parsePairingLink(b).ok).toBe(false);
  });

  it("falls back to a plain name if the PC name is odd", () => {
    const r = parsePairingLink(LINK.replace("n=Bay%203%20PC", "n=%3Cscript%3E"));
    expect(r.ok && r.link.name).toBe("Workshop PC");
    expect(cleanDeviceName("Pixel 8 Pro (✓)")).toBe("Pixel 8 Pro");
    expect(cleanDeviceName(undefined)).toBe("Android phone");
  });
});

function memoryKv() {
  const m = new Map<string, string>();
  return {
    m,
    getItemAsync: async (k: string) => m.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void m.set(k, v),
    deleteItemAsync: async (k: string) => void m.delete(k),
  };
}

const PC: PairedPc = {
  host: "192.168.1.20",
  port: 8766,
  fingerprint: FP,
  daemonId: "rcd_0011223344556677",
  name: "Bay 3 PC",
  deviceId: "lan_00112233445566aa",
  deviceSecret: "s".repeat(43),
  pairedAt: "2026-11-29T00:00:00.000Z",
};

describe("the paired PC in secure storage", () => {
  it("saves, reloads, notifies and forgets", async () => {
    const kv = memoryKv();
    const store = new PcStore(kv);
    expect(await store.load()).toBeNull();
    const seen: (PairedPc | null)[] = [];
    store.subscribe((p) => seen.push(p));
    await store.save(PC);
    expect(await new PcStore(kv).load()).toEqual(PC);
    await store.forget();
    expect(kv.m.has(PC_KEY)).toBe(false);
    expect(seen).toEqual([PC, null]);
  });

  it("ignores damaged storage", async () => {
    const kv = memoryKv();
    kv.m.set(PC_KEY, JSON.stringify({ ...PC, fingerprint: "nope" }));
    expect(await new PcStore(kv).load()).toBeNull();
    kv.m.set(PC_KEY, "{not json");
    expect(await new PcStore(kv).load()).toBeNull();
  });

  it("never gives the web app the device secret", () => {
    const info = publicInfo(PC);
    expect(JSON.stringify(info)).not.toContain(PC.deviceSecret);
    expect(info).toEqual({ paired: true, name: "Bay 3 PC", host: "192.168.1.20", port: 8766, fingerprint: FP.slice(0, 16) });
    expect(publicInfo(null)).toEqual({ paired: false });
  });
});

describe("pairing with the PC", () => {
  const link = (parsePairingLink(LINK) as { ok: true; link: PairingLink }).link;
  const deps = (native: FakeLink) => ({
    native,
    origin: "https://app.rootcauseobd.com.au",
    deviceName: "Pixel 8",
    clientVersion: "0.2.0",
    now: () => new Date("2026-11-29T00:00:00Z"),
  });

  it("pins the QR code's certificate, sends the code once, and keeps the PC's answer", async () => {
    const native = new FakeLink();
    const p = pairWithPc(link, deps(native));
    await flush();
    const [id, url, pin, auth, origin] = native.calls[0].args as string[];
    expect([url, pin, auth, origin]).toEqual(["wss://192.168.1.20:8766/", FP, `RootCause-Pair ${TOKEN}`, "https://app.rootcauseobd.com.au"]);
    native.open(id);
    const req = JSON.parse(native.calls.find((c) => c.op === "send")!.args[1] as string);
    expect(req).toMatchObject({ type: "LanPairRequest", device_name: "Pixel 8", client_version: "0.2.0" });
    native.message(
      id,
      JSON.stringify({
        type: "LanPairResponse",
        request_id: req.request_id,
        device_id: PC.deviceId,
        device_secret: PC.deviceSecret,
        daemon_id: PC.daemonId,
        daemon_name: "Bay 3 PC",
      }),
    );
    await expect(p).resolves.toEqual(PC);
    expect(native.calls.some((c) => c.op === "close" && c.args[0] === id)).toBe(true);
  });

  it("explains a certificate mismatch, and sends nothing", async () => {
    const native = new FakeLink();
    const p = pairWithPc(link, deps(native));
    await flush();
    native.closed(native.lastConnectId(), "identity");
    await expect(p).rejects.toThrow(/didn't match the pairing code/);
    expect(native.calls.some((c) => c.op === "send")).toBe(false);
  });

  it("explains a used or expired code", async () => {
    const native = new FakeLink();
    const p = pairWithPc(link, deps(native));
    await flush();
    native.closed(native.lastConnectId(), "revoked");
    await expect(p).rejects.toThrow(/expired/);
  });

  it("refuses an answer from a different PC", async () => {
    const native = new FakeLink();
    const p = pairWithPc(link, deps(native));
    await flush();
    const id = native.lastConnectId();
    native.open(id);
    const req = JSON.parse(native.calls.find((c) => c.op === "send")!.args[1] as string);
    native.message(
      id,
      JSON.stringify({ type: "LanPairResponse", request_id: req.request_id, device_id: PC.deviceId, device_secret: PC.deviceSecret, daemon_id: "rcd_ffffffffffffffff", daemon_name: "x" }),
    );
    await expect(p).rejects.toBeInstanceOf(PairingError);
  });

  it("gives up if the PC never answers", async () => {
    const native = new FakeLink();
    await expect(pairWithPc(link, { ...deps(native), timeoutMs: 20 })).rejects.toThrow(/didn't answer/);
  });
});

describe("relaying the web app's daemon connection", () => {
  function setup(pc: PairedPc | null = PC) {
    const native = new FakeLink();
    const injected: string[] = [];
    const relay = new DaemonRelay({ native, inject: (s) => injected.push(s), pc: () => pc, origin: "https://app.rootcauseobd.com.au", batchMs: 1 });
    const delivered = (): RelayEvent[] =>
      injected.flatMap((s) => JSON.parse(s.slice(s.indexOf("deliver(") + 8, s.lastIndexOf(");}})"))) as RelayEvent[]);
    return { native, relay, delivered };
  }

  it("connects with the phone's credential and the pinned certificate", async () => {
    const { native, relay, delivered } = setup();
    relay.openConnection("d1");
    expect(native.calls[0].args).toEqual(["d1", "wss://192.168.1.20:8766/", FP, `Bearer ${PC.deviceId}.${PC.deviceSecret}`, "https://app.rootcauseobd.com.au"]);
    native.open("d1");
    native.message("d1", '{"type":"HelloResponse"}');
    native.message("d1", '{"type":"CanFrameBatch"}');
    relay.send("d1", '{"type":"HelloRequest"}');
    expect(native.calls[1]).toEqual({ op: "send", args: ["d1", '{"type":"HelloRequest"}'] });
    await new Promise((r) => setTimeout(r, 5));
    // Frames arrive in one batch, in order.
    expect(delivered()).toEqual([
      { id: "d1", kind: "open" },
      { id: "d1", kind: "message", text: '{"type":"HelloResponse"}' },
      { id: "d1", kind: "message", text: '{"type":"CanFrameBatch"}' },
    ]);
  });

  it("says unpaired when no PC is paired", async () => {
    const { native, relay, delivered } = setup(null);
    relay.openConnection("d1");
    await new Promise((r) => setTimeout(r, 5));
    expect(native.calls).toEqual([]);
    expect(delivered()).toEqual([{ id: "d1", kind: "close", wasOpen: false, reason: "unpaired" }]);
  });

  it("passes on why the PC refused", async () => {
    const { native, relay, delivered } = setup();
    relay.openConnection("d1");
    native.closed("d1", "revoked");
    native.message("d1", "late"); // after close: dropped
    await new Promise((r) => setTimeout(r, 5));
    expect(delivered()).toEqual([{ id: "d1", kind: "close", wasOpen: false, reason: "revoked" }]);
  });

  it("closing from the web side doesn't echo a close back", async () => {
    const { native, relay, delivered } = setup();
    relay.openConnection("d1");
    relay.closeConnection("d1");
    native.closed("d1", "closed", true);
    relay.send("d1", "x");
    await new Promise((r) => setTimeout(r, 5));
    expect(native.calls.map((c) => c.op)).toEqual(["connect", "close"]);
    expect(delivered()).toEqual([]);
  });

  it("ignores the pairing connection's events", async () => {
    const { native, relay, delivered } = setup();
    relay.openConnection("d1");
    native.message("pairxyz", "secret stuff");
    await new Promise((r) => setTimeout(r, 5));
    expect(delivered()).toEqual([]);
  });

  it("a native failure to start reads as unreachable", async () => {
    const { native, relay, delivered } = setup();
    native.failConnect = new Error("boom");
    relay.openConnection("d1");
    await new Promise((r) => setTimeout(r, 5));
    expect(delivered()).toEqual([{ id: "d1", kind: "close", wasOpen: false, reason: "unreachable", detail: "boom" }]);
  });

  it("the delivery script is inert JSON", () => {
    const s = deliverScript([{ id: "d1", kind: "message", text: '"); alert(1); ("' }]);
    const got: unknown[] = [];
    new Function("window", s)({ RootCauseNativeDaemon: { deliver: (e: unknown) => got.push(e) } });
    expect(got).toEqual([[{ id: "d1", kind: "message", text: '"); alert(1); ("' }]]);
  });
});

describe("the bridge's phone-access messages", () => {
  const APP = "https://app.rootcauseobd.com.au";
  const from = `${APP}/devices`;
  it("accepts well-formed relay and pairing messages from the web app only", () => {
    expect(parseBridgeMessage('{"type":"lan-pair"}', from, APP)).toEqual({ type: "lan-pair" });
    expect(parseBridgeMessage('{"type":"lan-forget"}', from, APP)).toEqual({ type: "lan-forget" });
    expect(parseBridgeMessage('{"type":"daemon-open","id":"d1"}', from, APP)).toEqual({ type: "daemon-open", id: "d1" });
    expect(parseBridgeMessage('{"type":"daemon-send","id":"d1","text":"{}"}', from, APP)).toEqual({ type: "daemon-send", id: "d1", text: "{}" });
    expect(parseBridgeMessage('{"type":"daemon-close","id":"d1"}', from, APP)).toEqual({ type: "daemon-close", id: "d1" });
    expect(parseBridgeMessage('{"type":"daemon-open","id":"d1"}', "https://evil.example/", APP)).toBeNull();
    expect(parseBridgeMessage('{"type":"daemon-open","id":"../x"}', from, APP)).toBeNull();
    expect(parseBridgeMessage('{"type":"daemon-send","id":"d1"}', from, APP)).toBeNull();
    expect(parseBridgeMessage(JSON.stringify({ type: "daemon-send", id: "d1", text: "x".repeat(1_000_001) }), from, APP)).toBeNull();
  });

  it("tells the web app which PC is paired, and when it changes", () => {
    const listeners: string[] = [];
    const win: Record<string, unknown> = {
      dispatchEvent: (e: { type: string }) => listeners.push(e.type),
    };
    class FakeEvent {
      constructor(public type: string) {}
    }
    const run = (s: string) => new Function("window", "Event", s)(win, FakeEvent);
    run(bootstrapScript("0.2.0", publicInfo(null), true));
    const native = win.RootCauseNative as { platform: string; devLoopback?: boolean; daemon: { paired: boolean } };
    expect(native.platform).toBe("android");
    expect(native.devLoopback).toBe(true);
    expect(native.daemon).toEqual({ paired: false });
    run(daemonUpdateScript(publicInfo(PC)));
    expect(native.daemon).toMatchObject({ paired: true, host: "192.168.1.20" });
    expect(listeners).toEqual(["rootcause-native-daemon"]);
  });

  it("older behaviour without phone access is unchanged", () => {
    const win: Record<string, unknown> = {};
    new Function("window", bootstrapScript("0.2.0"))(win);
    expect(win.RootCauseNative).toEqual({ platform: "android", appVersion: "0.2.0" });
  });
});
