import { describe, expect, it } from "vitest";
import { candidateIds, classifyBits, ingest, rateHz, type IdStats } from "@/lib/can-analysis";

const f = (id: number, data: string, t: number) => ({ timestamp_us: t, can_id: id, is_extended: false, dlc: data.length / 2, data_hex: data });

describe("CAN analysis", () => {
  it("tracks toggled bits and rate", () => {
    const m = new Map<number, IdStats>();
    ingest(m, [f(0x100, "0001", 0), f(0x100, "0003", 100_000), f(0x100, "0001", 200_000)], 1);
    const s = m.get(0x100)!;
    expect(s.count).toBe(3);
    expect(s.toggled[1]).toBe(0x02);
    expect(rateHz(s)).toBeCloseTo(10);
  });
  it("separates noisy bits from bits that change only during the action", () => {
    const base = new Map<number, IdStats>();
    const act = new Map<number, IdStats>();
    // Byte 0 is a rolling counter (noise in both); byte 1 bit 4 is the switch.
    ingest(base, [f(0x3e9, "0000", 0), f(0x3e9, "0100", 1), f(0x3e9, "0200", 2)], 1);
    ingest(act, [f(0x3e9, "0300", 0), f(0x3e9, "0410", 1), f(0x3e9, "0500", 2)], 1);
    const classes = classifyBits(base.get(0x3e9), act.get(0x3e9), 2);
    expect(classes[8 + 4]).toBe("candidate");
    expect(classes[0]).toBe("noise");
    expect(classes[16]).toBe("unused");
    // The counter reaching a higher bit during the action also shows up: the
    // UI tells technicians to record a longer baseline for exactly this reason.
    expect(classes[2]).toBe("candidate");
    expect(candidateIds(base, act)).toEqual([{ id: 0x3e9, bits: 2 }]);
  });
});
