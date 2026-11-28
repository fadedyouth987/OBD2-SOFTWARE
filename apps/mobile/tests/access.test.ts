import plans from "@obd2/schemas/plan_features.json";
import { access, cheapestPlanFor, type FeatureKey, type MeSummary, type Tier } from "../src/plan/access";

const TIERS: Tier[] = ["COMMUNITY", "MOBILE", "PRO", "WORKSHOP", "FLEET"];

function me(tier: Tier, used = 0, immo = false): MeSummary {
  const t = plans.tiers.find((x) => x.tier === tier)!;
  return {
    entitlements: { tier, ai_diagnoses: t.ai_diagnoses, schematic_pages: t.schematic_pages, immo_entitled: immo },
    usage: { ai_diagnoses_used: used, schematic_pages_used: 0 },
  };
}

describe("plan matrix: every app feature for every plan matches plan_features.json", () => {
  for (const f of plans.app_features) {
    for (const tier of TIERS) {
      const included = (f.tiers as string[]).includes(tier);
      const expected = f.desktop_only ? "desktop_only" : included ? "available" : "locked";
      it(`${f.key} on ${tier} is ${expected}`, () => {
        const immo = f.key === "IMMO_PROGRAM";
        expect(access(f.key as FeatureKey, me(tier, 0, immo)).state).toBe(expected);
      });
    }
  }
});

describe("plan rules people will notice", () => {
  it("locks recording for Community and names Mobile as the cheapest plan that has it", () => {
    expect(access("MOBILE_RECORDING", me("COMMUNITY"))).toEqual({ state: "locked", unlockWith: "Mobile" });
    expect(cheapestPlanFor("MOBILE_RECORDING")).toBe("Mobile");
  });

  it("gives Community customer reports, the same as on the web", () => {
    expect(access("CUSTOMER_REPORT", me("COMMUNITY")).state).toBe("available");
  });

  it("counts AI diagnoses against the plan's monthly quota", () => {
    expect(access("AI_DIAGNOSIS", me("MOBILE", 10))).toEqual({ state: "available", quota: { used: 10, limit: 40, left: 30 } });
    expect(access("AI_DIAGNOSIS", me("COMMUNITY", 5))).toEqual({ state: "quota_used", quota: { used: 5, limit: 5, left: 0 } });
  });

  it("shows clear codes as desktop only, and says whether the plan includes it", () => {
    const pro = access("UDS_ACTIVE", me("PRO"));
    const mobile = access("UDS_ACTIVE", me("MOBILE"));
    expect(pro.state === "desktop_only" && pro.why).toMatch(/on your plan/);
    expect(mobile.state === "desktop_only" && mobile.why).toMatch(/needs Pro/);
  });

  it("treats a signed-out app as Community", () => {
    expect(access("MOBILE_RECORDING", null).state).toBe("locked");
    expect(access("READ_CODES", null).state).toBe("available");
  });
});
