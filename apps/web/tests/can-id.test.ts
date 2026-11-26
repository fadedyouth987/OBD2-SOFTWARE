import { describe, expect, it } from "vitest";
import { canIdText } from "@/lib/diag";

describe("canIdText (A-DES-7)", () => {
  it("shows 11-bit IDs with 3 hex digits", () => {
    expect(canIdText(0x7e8, false)).toBe("0x7E8");
    expect(canIdText(0x0c4, false)).toBe("0x0C4");
  });
  it("shows 29-bit extended IDs with all 8 hex digits", () => {
    expect(canIdText(0x18daf110, true)).toBe("0x18DAF110");
    expect(canIdText(0x1fffffff, true)).toBe("0x1FFFFFFF");
    expect(canIdText(0x123, true)).toBe("0x00000123");
  });
});
