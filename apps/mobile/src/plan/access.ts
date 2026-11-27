// What the signed-in workspace's plan unlocks in the app, from the one plan table
// (packages/schemas/plan_features.json). The server enforces quotas and lease
// features; this decides what the app shows as available, locked or desktop-only.

import plans from "@obd2/schemas/plan_features.json";

export type Tier = "COMMUNITY" | "MOBILE" | "PRO" | "WORKSHOP" | "FLEET";
export type FeatureKey = (typeof plans.app_features)[number]["key"];

export type Access =
  | { state: "available"; quota?: { used: number; limit: number; left: number } }
  | { state: "quota_used"; quota: { used: number; limit: number; left: 0 } }
  | { state: "locked"; unlockWith: string }
  | { state: "desktop_only"; why: string };

/** The parts of GET /api/v1/auth/me the app needs. */
export interface MeSummary {
  entitlements: { tier: Tier; ai_diagnoses: number; schematic_pages: number; immo_entitled: boolean };
  usage: { ai_diagnoses_used: number; schematic_pages_used: number };
}

const ORDER = [...plans.tiers].sort((a, b) => a.rank - b.rank);

export const TIER_NAME: Record<Tier, string> = Object.fromEntries(
  plans.tiers.map((t) => [t.tier, t.display_name]),
) as Record<Tier, string>;

export const APP_FEATURES = plans.app_features;

export function featureInfo(key: FeatureKey) {
  const f = plans.app_features.find((x) => x.key === key);
  if (!f) throw new Error(`Unknown app feature ${key}`);
  return f;
}

/** The cheapest plan that includes a feature, e.g. "Mobile". */
export function cheapestPlanFor(key: FeatureKey): string {
  const f = featureInfo(key);
  const t = ORDER.find((p) => (f.tiers as string[]).includes(p.tier));
  return t ? t.display_name : "a higher plan";
}

export function access(key: FeatureKey, me: MeSummary | null): Access {
  const f = featureInfo(key);
  const tier: Tier = me?.entitlements.tier ?? "COMMUNITY";
  const included = (f.tiers as string[]).includes(tier) && (key !== "IMMO_PROGRAM" || !!me?.entitlements.immo_entitled);
  if (f.desktop_only) {
    return {
      state: "desktop_only",
      why: included
        ? `${f.label} is on your plan. Use the desktop app, which runs the safety checks first.`
        : `${f.label} needs ${cheapestPlanFor(key)} or higher and the desktop app.`,
    };
  }
  if (!included) return { state: "locked", unlockWith: cheapestPlanFor(key) };
  if ("quota" in f && f.quota === "ai_diagnoses" && me) {
    const limit = me.entitlements.ai_diagnoses;
    const used = me.usage.ai_diagnoses_used;
    const left = Math.max(0, limit - used);
    return left === 0 ? { state: "quota_used", quota: { used, limit, left: 0 } } : { state: "available", quota: { used, limit, left } };
  }
  return { state: "available" };
}
