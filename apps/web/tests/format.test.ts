import { describe, expect, it } from "vitest";
import { formatReading, safetyTierLabel } from "../src/lib/format";

describe("formatReading", () => {
  it("shows whole numbers without trailing zeros", () => {
    expect(formatReading(0)).toBe("0");
    expect(formatReading(20)).toBe("20");
    expect(formatReading(2450)).toBe("2,450");
  });
  it("scales precision with magnitude", () => {
    expect(formatReading(0.456)).toBe("0.46");
    expect(formatReading(12.345)).toBe("12.3");
    expect(formatReading(812.7)).toBe("813");
  });
});

describe("safetyTierLabel", () => {
  it("maps API tiers to readable labels", () => {
    expect(safetyTierLabel("SILENT")).toEqual({ label: "Read-only", tone: "ok" });
    expect(safetyTierLabel("TIER A")).toEqual({ label: "Confirm · Tier A", tone: "warn" });
    expect(safetyTierLabel("TIER A / B")).toEqual({ label: "Confirm · Tier A/B", tone: "warn" });
  });
});
