import { describe, expect, it } from "vitest";
import { EdgeRequestError } from "@/lib/edge-client";
import { mergeDtcs, mergeJobDtcs, parseKwpDtcs, scanModule, scanTargets, type DiagFn } from "@/lib/scan";

const ok = (hex: string) => ({ type: "DiagCommandResponse" as const, request_id: "x", positive: true, response_hex: hex, nrc: null });
const nrc = (sid: number, code: number) => ({
  type: "DiagCommandResponse" as const,
  request_id: "x",
  positive: false,
  response_hex: `7F${sid.toString(16).padStart(2, "0")}${code.toString(16).padStart(2, "0")}`,
  nrc: { code, name: "n" },
});

describe("scanTargets", () => {
  it("uses the simulator's own modules for virtual adapters", () => {
    expect(scanTargets("virtual-ford-falcon-ba", null).map((t) => t.module)).toEqual(["PCM", "IC", "ABS"]);
  });
  it("adds plain OBD on the engine for an unknown vehicle", () => {
    expect(scanTargets("elm-1", null)).toEqual([{ module: "ENGINE", tx: 0x7e0, rx: 0x7e8, protocol: null, obd: true }]);
  });
  it("skips the functional 0x7DF address and infers BMW KWP", () => {
    const t = scanTargets("elm-1", [
      { id: "ECM", bus: "OBD", tx: "0x7DF", rx: "0x7E8" },
      { id: "DME", bus: "D-CAN", tx: "0x6F1", rx: "0x612" },
    ]);
    expect(t.map((x) => [x.module, x.protocol, x.obd])).toEqual([
      ["ENGINE", null, true],
      ["DME", "KWP2000", false],
    ]);
  });
});

describe("parseKwpDtcs", () => {
  it("keeps BMW hex codes", () => {
    expect(parseKwpDtcs("5802 2A82 24 29E0 00".replace(/ /g, "")).map((d) => [d.code, d.status])).toEqual([
      ["2A82", "stored"],
      ["29E0", "history"],
    ]);
  });
});

describe("scanModule", () => {
  const engine = { module: "PCM", tx: 0x7e0, rx: 0x7e8, protocol: "UDS" as const, obd: true };
  it("merges OBD and UDS results per code", async () => {
    const diag: DiagFn = async ({ payloadHex }) =>
      ({ "03": ok("43010171"), "07": ok("47010174"), "0A": ok("4A00"), "1902FF": ok("5902FF01710009") })[payloadHex]!;
    const r = await scanModule(diag, engine);
    expect(r.outcome).toBe("codes");
    expect(r.dtcs.map((d) => [d.code, d.status])).toEqual([
      ["P0171", "confirmed"],
      ["P0174", "pending"],
    ]);
    expect(r.dtcs[0].source).toBe("OBD mode 03, UDS 19 02");
  });
  it("reports a silent module as no response, not as clear", async () => {
    const diag: DiagFn = async () => {
      throw new EdgeRequestError("TIMEOUT", "no reply", "");
    };
    expect((await scanModule(diag, engine)).outcome).toBe("no_response");
  });
  it("reports refusals honestly", async () => {
    const t = { module: "ABS", tx: 0x760, rx: 0x768, protocol: "UDS" as const, obd: false };
    const r = await scanModule(async () => nrc(0x19, 0x22), t);
    expect(r.outcome).toBe("refused");
    expect(r.message).toMatch(/Conditions/);
  });
  it("says clear only when the module answered with no codes", async () => {
    const t = { module: "IC", tx: 0x720, rx: 0x728, protocol: "UDS" as const, obd: false };
    expect((await scanModule(async () => ok("5902FF"), t)).outcome).toBe("clear");
  });
});

describe("mergeDtcs", () => {
  it("keeps the most serious status", () => {
    const m = mergeDtcs([
      { code: "P0171", module: "PCM", source: "A", status: "pending", statusByte: null, ftb: null },
      { code: "P0171", module: "PCM", source: "B", status: "confirmed", statusByte: 9, ftb: 0 },
    ]);
    expect(m).toHaveLength(1);
    expect(m[0].status).toBe("confirmed");
    expect(m[0].source).toBe("A, B");
  });
});

describe("mergeJobDtcs", () => {
  const rec = (code: string, module: string, status = "confirmed") => ({ code, module, status, source: "UDS 19 02", description: "", status_byte: null });
  const res = (module: string, outcome: "codes" | "clear" | "no_response") =>
    ({ target: { module, tx: 0x7e0, rx: 0x7e8, protocol: "UDS", obd: false }, outcome, dtcs: [], message: "" }) as never;
  it("keeps codes that a verification rescan no longer sees, marked cleared", () => {
    const merged = mergeJobDtcs([rec("P0171", "PCM"), rec("C1145", "ABS")], [res("PCM", "clear"), res("ABS", "clear")], []);
    expect(merged.map((d) => [d.code, d.status])).toEqual([["P0171", "cleared"], ["C1145", "cleared"]]);
  });
  it("replaces codes read again and leaves silent modules alone", () => {
    const merged = mergeJobDtcs(
      [rec("P0171", "PCM", "pending"), rec("C1145", "ABS")],
      [res("PCM", "codes"), res("ABS", "no_response")],
      [rec("P0171", "PCM", "confirmed")],
    );
    expect(merged.map((d) => [d.code, d.status])).toEqual([["P0171", "confirmed"], ["C1145", "confirmed"]]);
  });
});
