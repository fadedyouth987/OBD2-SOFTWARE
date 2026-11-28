import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { EdgeRequestError } from "@/lib/edge-client";
import { CATALOG, catalogName, familyFor, sweepAddresses, unnamedLabel } from "@/lib/module-catalog";
import { buildPlan, discover, moduleNetwork, networkOf, type DiagFn } from "@/lib/module-discovery";
import { scanModule } from "@/lib/scan";
import type { VehicleModule } from "@/lib/api";

const schema = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/schemas/module_catalog.schema.json"), "utf8"));
const timeout = () => new EdgeRequestError("TIMEOUT", "no reply from the ECU", "");

describe("module catalogue", () => {
  it("matches its schema", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const valid = ajv.validate(schema, CATALOG);
    expect(ajv.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it("cites a source for every named module and defines every sweep", () => {
    for (const [name, fam] of Object.entries(CATALOG.families)) {
      for (const m of [...fam.modules, ...fam.subaddressed]) expect(CATALOG.sources[m.source], `${name} ${m.abbr}`).toBeDefined();
      for (const s of fam.sweeps) expect(CATALOG.sweeps[s], `${name} ${s}`).toBeDefined();
    }
  });

  it("falls back to generic discovery for unknown families", () => {
    expect(familyFor("nope").id).toBe("generic");
    expect(familyFor(null).id).toBe("generic");
    expect(familyFor("ford").id).toBe("ford");
  });

  it("names Ford modules from the PX3 manual", () => {
    const ford = familyFor("ford").family;
    expect(catalogName(ford, 0x726, 0x72e)?.abbr).toBe("BCM");
    expect(catalogName(ford, 0x7d0, 0x7d8)?.abbr).toBe("APIM");
    expect(catalogName(ford, 0x7d0, 0x7d1)).toBeNull();
  });
});

describe("sweeps", () => {
  it("covers 0x700-0x7F7 without the functional address", () => {
    const a = sweepAddresses("std11");
    expect(a).toHaveLength(0x7f7 - 0x700 + 1 - 1);
    expect(a.some((x) => x.tx === 0x7df)).toBe(false);
    expect(a.every((x) => x.rx === x.tx + 8 && x.protocol === "UDS")).toBe(true);
  });

  it("uses each make's reply offset", () => {
    expect(sweepAddresses("vag11").find((x) => x.tx === 0x714)?.rx).toBe(0x77e);
    expect(sweepAddresses("gm11").find((x) => x.tx === 0x243)?.rx).toBe(0x643);
    expect(sweepAddresses("chrysler11").find((x) => x.tx === 0x747)?.rx).toBe(0x4c7);
  });

  it("builds ISO 29-bit and BMW extended addresses", () => {
    const iso = sweepAddresses("iso29");
    expect(iso).toHaveLength(256);
    expect(iso.find((x) => x.tx === 0x18da28f1)?.rx).toBe(0x18daf128);
    const bmw = sweepAddresses("bmw_ext");
    expect(bmw.find((x) => x.rx === 0x612)).toMatchObject({ tx: 0x6f1, protocol: "KWP2000" });
    expect(unnamedLabel(0x6f1, 0x672)).toBe("Module at BMW address 0x72");
    expect(unnamedLabel(0x18da77f1, 0x18daf177)).toBe("Module at 29-bit address 0x77");
  });
});

const PX3: VehicleModule[] = [
  { id: "PCM", bus: "HS-CAN1", tx: "0x7E0", rx: "0x7E8", network: "HS_CAN" },
  { id: "BCM", bus: "HS-CAN1", tx: "0x726", rx: "0x72E", network: "HS_CAN" },
  { id: "ABS", bus: "HS-CAN2 (DIAG 2)", tx: "0x760", rx: "0x768", network: "HS_CAN2" },
  { id: "RTM", bus: "MS-CAN via gateway", tx: "0x751", rx: "0x759", network: "HS_CAN" },
];

describe("buildPlan", () => {
  it("probes the vehicle's own modules first, then the catalogue, then the sweep, once each", () => {
    const plan = buildPlan({ family: "ford", registryModules: PX3, protocol: "ISO15765_11_500" });
    expect(plan.network).toBe("HS_CAN");
    expect(plan.probes.slice(0, 3).map((p) => p.label)).toEqual(["PCM", "BCM", "RTM"]);
    const keys = plan.probes.map((p) => `${p.tx}:${p.rx}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(plan.probes.some((p) => p.tx === 0x7df)).toBe(false);
    // The sweep reaches addresses no list names.
    expect(plan.probes.find((p) => p.tx === 0x7a5)).toMatchObject({ named: false, label: "Module at 0x7A5" });
  });

  it("reports modules on another network instead of probing them", () => {
    const plan = buildPlan({ family: "ford", registryModules: PX3, protocol: "ISO15765_11_500" });
    expect(plan.elsewhere).toHaveLength(1);
    expect(plan.elsewhere[0]).toMatchObject({ outcome: "other_network", target: { module: "ABS" } });
    expect(plan.elsewhere[0].message).toMatch(/pins 3\/11/);
    expect(plan.probes.some((p) => p.label === "ABS")).toBe(true); // the catalogue still probes the address on this network
  });

  it("MS-CAN modules are reachable once connected on MS-CAN", () => {
    const fg: VehicleModule[] = [
      { id: "PCM", bus: "HS-CAN 500k", tx: "0x7E0", rx: "0x7E8" },
      { id: "BEM", bus: "MS-CAN 125k (STP 53)", tx: "0x726", rx: "0x72E" },
    ];
    const hs = buildPlan({ family: "ford", registryModules: fg, protocol: "ISO15765_11_500" });
    expect(hs.elsewhere.map((r) => r.target.module)).toEqual(["BEM"]);
    expect(hs.elsewhere[0].message).toMatch(/STN/);
    const ms = buildPlan({ family: "ford", registryModules: fg, protocol: "MS_CAN_125" });
    expect(ms.elsewhere.map((r) => r.target.module)).toEqual(["PCM"]);
    expect(ms.probes[0].label).toBe("BEM");
  });

  it("doesn't sweep on a non-CAN connection", () => {
    const plan = buildPlan({ family: "ford", registryModules: [], protocol: "J1850_PWM" });
    expect(plan.probes).toHaveLength(0);
    expect(plan.notes.join(" ")).toMatch(/J1850 PWM/);
  });

  it("explains Toyota modules it can't reach yet", () => {
    const plan = buildPlan({ family: "toyota", registryModules: null, protocol: "ISO15765_11_500" });
    expect(plan.notes.join(" ")).toMatch(/sub-addressing/);
  });

  it("infers networks from older registry entries", () => {
    expect(moduleNetwork({ bus: "MS-CAN 125k (STP 53)" })).toBe("MS_CAN");
    expect(moduleNetwork({ bus: "J1850 VPW" })).toBe("J1850_VPW");
    expect(moduleNetwork({ bus: "HS-CAN 500k" })).toBe("HS_CAN");
    expect(networkOf("MS_CAN_125")).toBe("MS_CAN");
    expect(networkOf("AUTO")).toBe("HS_CAN");
  });
});

describe("discover", () => {
  const answering = (present: Set<number>, extra?: (tx: number) => void): DiagFn => async (req) => {
    extra?.(req.tx);
    if (req.payloadHex !== "3E00" && req.payloadHex !== "3E01") throw new Error("probe must be TesterPresent");
    if (!present.has(req.tx)) throw timeout();
    return { positive: req.tx !== 0x737 }; // the RCM refuses TesterPresent: still present
  };

  it("finds what answers, positive or negative, and names it", async () => {
    const plan = buildPlan({ family: "ford", registryModules: PX3, protocol: "ISO15765_11_500" });
    const r = await discover(answering(new Set([0x7e0, 0x726, 0x737, 0x7a5])), plan, { paceMs: 0 });
    expect(r.found.map((t) => t.module)).toEqual(["PCM", "BCM", "RCM", "Module at 0x7A5"]);
    expect(r.found[0]).toMatchObject({ obd: true, protocol: "UDS" });
    expect(r.found.find((t) => t.module === "RCM")?.name).toBe("Restraint Control Module");
    expect(r.found.find((t) => t.module === "Module at 0x7A5")?.discovered).toBe(true);
  });

  it("asks for emissions codes even when the engine ignores TesterPresent", async () => {
    const plan = buildPlan({ family: "generic", registryModules: null, protocol: "ISO15765_11_500" });
    const r = await discover(answering(new Set([0x760])), { ...plan, probes: plan.probes.slice(0, 300) }, { paceMs: 0 });
    expect(r.found[0]).toMatchObject({ module: "ENGINE", tx: 0x7e0, obd: true, protocol: null });
  });

  it("stops probing 29-bit ids once the adapter says it can't send them", async () => {
    const plan = buildPlan({ family: "honda", registryModules: null, protocol: "ISO15765_11_500" });
    let wide = 0;
    const diag: DiagFn = async (req) => {
      if (req.tx > 0x7ff) {
        wide += 1;
        throw new EdgeRequestError("ADAPTER_ERROR", "Can11_500 expects 11-bit ids", "");
      }
      throw timeout();
    };
    const r = await discover(diag, plan, { paceMs: 0 });
    expect(wide).toBe(1);
    expect(r.skipped).toBeGreaterThan(200);
    expect(r.notes.join(" ")).toMatch(/29-bit modules weren't checked/);
  });

  it("retries once after the daemon's rate limit", async () => {
    let calls = 0;
    const diag: DiagFn = async () => {
      calls += 1;
      if (calls === 1) throw new EdgeRequestError("PROTOCOL_ERROR", "rate limit: at most 20 DiagCommandRequest per second", "");
      return { positive: true };
    };
    const plan = { family: "ford", network: "HS_CAN" as const, elsewhere: [], notes: [], probes: [{ tx: 0x726, rx: 0x72e, protocol: "UDS" as const, label: "BCM", name: null, named: true, sweep: null }] };
    const r = await discover(diag, plan, { paceMs: 0 });
    expect(calls).toBe(2);
    expect(r.found.map((t) => t.module)).toContain("BCM");
  });

  it("can be stopped part way", async () => {
    const plan = buildPlan({ family: "ford", registryModules: null, protocol: "ISO15765_11_500" });
    const stop = new AbortController();
    let n = 0;
    const r = await discover(
      async () => {
        n += 1;
        if (n === 5) stop.abort();
        throw timeout();
      },
      plan,
      { paceMs: 0, signal: stop.signal },
    );
    expect(n).toBe(5);
    expect(r.notes.join(" ")).toMatch(/Stopped after 5/);
  });
});

describe("scanModule KWP fallback", () => {
  it("asks a module that doesn't know UDS 19 with KWP2000 instead", async () => {
    const seen: string[] = [];
    const diag = async (req: { protocol: string; payloadHex: string }) => {
      seen.push(`${req.protocol}:${req.payloadHex}`);
      if (req.protocol === "UDS") {
        return { type: "DiagCommandResponse" as const, request_id: "x", positive: false, response_hex: "7F1911", nrc: { code: 0x11, name: "serviceNotSupported" } };
      }
      return { type: "DiagCommandResponse" as const, request_id: "x", positive: true, response_hex: "5801C10024", nrc: null };
    };
    const r = await scanModule(diag as never, { module: "ABS", tx: 0x740, rx: 0x748, protocol: "UDS", obd: false });
    expect(seen).toEqual(["UDS:1902FF", "KWP2000:1802FF00"]);
    expect(r.outcome).toBe("codes");
    expect(r.dtcs.map((d) => d.code)).toEqual(["C100"]);
  });

  it("reports refused when KWP is refused too", async () => {
    const diag = async (req: { protocol: string }) => ({
      type: "DiagCommandResponse" as const,
      request_id: "x",
      positive: false,
      response_hex: req.protocol === "UDS" ? "7F1911" : "7F1822",
      nrc: { code: req.protocol === "UDS" ? 0x11 : 0x22, name: "n" },
    });
    const r = await scanModule(diag as never, { module: "ABS", tx: 0x740, rx: 0x748, protocol: "UDS", obd: false });
    expect(r.outcome).toBe("refused");
  });
});
