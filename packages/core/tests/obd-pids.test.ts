import { describe, expect, it } from "vitest";
import { decodeMode01, decodeReadiness, decodeSupported } from "../src/obd-pids";

describe("decodeMode01", () => {
  it("decodes one PID", () => {
    expect(decodeMode01([0x41, 0x0c, 0x1a, 0xf8])).toEqual([
      { pid: 0x0c, name: "Engine speed", unit: "rpm", value: 1726 },
    ]);
  });
  it("decodes several PIDs in one CAN reply", () => {
    const v = decodeMode01([0x41, 0x0d, 0x32, 0x05, 0x7b, 0x42, 0x36, 0xb0]);
    expect(v.map((x) => [x.pid, x.value])).toEqual([
      [0x0d, 50],
      [0x05, 83],
      [0x42, 14],
    ]);
  });
  it("stops at an unknown PID or a short reply instead of guessing", () => {
    expect(decodeMode01([0x41, 0x0d, 0x10, 0x99, 0x01, 0x05, 0x50])).toHaveLength(1);
    expect(decodeMode01([0x41, 0x0c, 0x1a])).toEqual([]);
    expect(decodeMode01([0x7f, 0x01, 0x12])).toEqual([]);
  });
  it("decodes fuel trims around zero", () => {
    expect(decodeMode01([0x41, 0x06, 0x80])[0].value).toBe(0);
    expect(decodeMode01([0x41, 0x07, 0x90])[0].value).toBe(12.5);
  });
});

describe("decodeSupported", () => {
  it("reads the bitmap from base+1", () => {
    // BE 1F A8 13: the standard example from SAE J1979
    expect(decodeSupported(0x00, [0xbe, 0x1f, 0xa8, 0x13])).toEqual([
      0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x1c, 0x1f, 0x20,
    ]);
  });
});

describe("decodeReadiness", () => {
  it("reports MIL, code count and each petrol monitor", () => {
    // MIL on, 2 codes; misfire+fuel+components supported, fuel incomplete;
    // catalyst + O2 + O2 heater supported, catalyst incomplete.
    const r = decodeReadiness([0x82, 0x27, 0x61, 0x01]);
    expect(r.milOn).toBe(true);
    expect(r.storedCodes).toBe(2);
    expect(r.ignition).toBe("spark");
    const state = Object.fromEntries(r.monitors.map((m) => [m.name, m.state]));
    expect(state.Misfire).toBe("complete");
    expect(state["Fuel system"]).toBe("incomplete");
    expect(state.Catalyst).toBe("incomplete");
    expect(state["Oxygen sensor"]).toBe("complete");
    expect(state["EGR system"]).toBe("not supported");
  });
  it("switches to diesel monitors and skips reserved bits", () => {
    const r = decodeReadiness([0x00, 0x08, 0x40, 0x00]);
    expect(r.ignition).toBe("compression");
    expect(r.monitors.find((m) => m.name === "Particulate filter")?.state).toBe("complete");
    expect(r.monitors.some((m) => m.name === "Reserved")).toBe(false);
  });
});
