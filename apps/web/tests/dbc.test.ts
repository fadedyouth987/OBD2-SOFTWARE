import { describe, expect, it } from "vitest";
import { decodeSignal, parseDbc, signalBits } from "@/lib/dbc";

const DBC = `VERSION ""

BO_ 1001 BCM_Status: 8 BCM
 SG_ DoorFL : 0|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ Speed : 8|16@1+ (0.01,0) [0|655.35] "km/h" Vector__XXX
 SG_ Temp : 24|8@1- (1,-40) [-40|215] "degC" Vector__XXX
 SG_ RpmBE : 39|16@0+ (0.25,0) [0|16383] "rpm" Vector__XXX
 SG_ Mux M : 63|4@0+ (1,0) [0|15] "" Vector__XXX
 SG_ MuxVal m1 : 59|4@0+ (1,0) [0|15] "" Vector__XXX

BO_ 2566834709 EXT_Msg: 8 X
 SG_ Val : 0|8@1+ (2,1) [0|511] "" Vector__XXX

CM_ "comment";
`;

describe("parseDbc", () => {
  const dbc = parseDbc(DBC);
  it("reads messages, extended ids and signals", () => {
    expect([...dbc.messages.keys()]).toEqual([1001, 2566834709 - 0x80000000]);
    const m = dbc.messages.get(1001)!;
    expect(m.name).toBe("BCM_Status");
    expect(m.extended).toBe(false);
    expect(m.signals.map((s) => [s.name, s.multiplex])).toEqual([
      ["DoorFL", "plain"],
      ["Speed", "plain"],
      ["Temp", "plain"],
      ["RpmBE", "plain"],
      ["Mux", "multiplexor"],
      ["MuxVal", "multiplexed"],
    ]);
    expect(dbc.messages.get(2566834709 - 0x80000000)!.extended).toBe(true);
    expect(dbc.warnings).toEqual([]);
  });
  it("decodes Intel and Motorola, signed and scaled", () => {
    const m = dbc.messages.get(1001)!;
    const sig = (n: string) => m.signals.find((s) => s.name === n)!;
    //            b0    b1    b2    b3    b4    b5    b6    b7
    const data = [0x01, 0x10, 0x27, 0xec, 0x0b, 0xb8, 0x00, 0x10];
    expect(decodeSignal(sig("DoorFL"), data)).toBe(1);
    expect(decodeSignal(sig("Speed"), data)).toBeCloseTo(100.0); // 0x2710 = 10000
    expect(decodeSignal(sig("Temp"), data)).toBe(-60); // 0xEC = -20, -20 - 40
    expect(decodeSignal(sig("RpmBE"), data)).toBe(750); // 0x0BB8 = 3000 * 0.25
    expect(decodeSignal(sig("Mux"), data)).toBe(1);
    expect(decodeSignal(sig("Speed"), [0x00])).toBeNull();
  });
  it("lists the bits a Motorola signal occupies", () => {
    const rpm = dbc.messages.get(1001)!.signals.find((s) => s.name === "RpmBE")!;
    const bits = signalBits(rpm);
    expect(bits.slice(0, 8)).toEqual([39, 38, 37, 36, 35, 34, 33, 32]);
    expect(bits.slice(8)).toEqual([47, 46, 45, 44, 43, 42, 41, 40]);
  });
  it("warns about unreadable lines instead of failing", () => {
    const bad = parseDbc("BO_ 5 X: 8 N\n SG_ broken line\n");
    expect(bad.messages.size).toBe(1);
    expect(bad.warnings).toHaveLength(1);
  });
});
