import { describe, expect, it } from "vitest";
import { liveChecks } from "@/lib/safety-checks";
import { SAFETY_POLICY } from "@/lib/edge-protocol";

const fresh = { speedAgeMs: 100, rpmAgeMs: 100, batteryAgeMs: 100 };
const states = (c: { state: string }[]) => c.map((x) => x.state);

describe("liveChecks (A-DES-3, Rule 5: fail closed)", () => {
  it("passes fresh readings that meet Tier B", () => {
    const c = liveChecks("B", { speedKmh: 0, rpm: 0, batteryV: 12.8, ...fresh });
    expect(states(c).every((s) => s === "ok")).toBe(true);
  });

  it("treats a missing reading as unknown, never as met", () => {
    const c = liveChecks("A", { speedKmh: null, rpm: null, batteryV: null });
    expect(c[0]).toMatchObject({ state: "unknown", value: "no reading" });
  });

  it("treats a speed reading older than the policy allows as unknown", () => {
    const max = SAFETY_POLICY.tiers.A.max_speed_age_ms;
    const c = liveChecks("A", { speedKmh: 0, rpm: 0, batteryV: 12.8, speedAgeMs: max + 1 });
    expect(c[0].state).toBe("unknown");
    expect(c[0].value).toMatch(/stale/);
    expect(liveChecks("A", { speedKmh: 0, rpm: 0, batteryV: 12.8, speedAgeMs: max })[0].state).toBe("ok");
  });

  it("fails a moving vehicle and a low battery", () => {
    const c = liveChecks("B", { speedKmh: 12, rpm: 0, batteryV: 11.9, ...fresh });
    expect(states(c)).toContain("fail");
    expect(c.find((x) => x.label.startsWith("Battery"))?.state).toBe("fail");
  });

  it("accepts adapter voltage that has no sample time", () => {
    const c = liveChecks("B", { speedKmh: 0, rpm: 0, batteryV: 12.6, speedAgeMs: 50, rpmAgeMs: 50, batteryAgeMs: null });
    expect(c.find((x) => x.label.startsWith("Battery"))?.state).toBe("ok");
  });
});
