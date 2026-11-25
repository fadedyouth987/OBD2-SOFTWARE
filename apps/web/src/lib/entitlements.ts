import type { Me, PlanTier, LeaseFeature } from "@/lib/api";
import type { LeaseStatus } from "@/types/edge-protocol";

export const TIER_LABEL: Record<PlanTier, string> = {
  COMMUNITY: "Community",
  PRO: "Pro",
  WORKSHOP: "Workshop",
  FLEET: "Fleet",
};

export const FEATURE_INFO: Record<LeaseFeature, { label: string; plan: string; what: string }> = {
  UDS_ACTIVE: {
    label: "Active diagnostics",
    plan: "Pro",
    what: "Clear codes, run service functions and other confirmed actions on the vehicle.",
  },
  CAN_RE_PRO: {
    label: "CAN Studio",
    plan: "Workshop",
    what: "Raw CAN frames, bit-change analysis and DBC files.",
  },
  J2534: {
    label: "J2534 pass-thru",
    plan: "Workshop",
    what: "Use J2534 vendor interfaces (VCIs) through the pass-thru bridge.",
  },
  IMMO_PROGRAM: {
    label: "Key programming",
    plan: "Workshop + IMMO add-on",
    what: "AASRA-gated immobilizer key learning with owner authorisation.",
  },
};

export type FeatureAccess =
  /** The plan includes it and the connected daemon's lease carries it. */
  | "available"
  /** The workshop's plan doesn't include it. */
  | "plan_locked"
  /** The plan includes it but the daemon's lease doesn't yet (install a fresh lease). */
  | "lease_missing"
  /** Plan includes it; no daemon connected to check the lease. */
  | "daemon_needed";

export function planHas(me: Me | null, feature: LeaseFeature): boolean {
  if (!me) return false;
  if (feature === "IMMO_PROGRAM") return me.entitlements.immo_entitled;
  return me.entitlements.features.includes(feature);
}

export function featureAccess(me: Me | null, lease: LeaseStatus | null, feature: LeaseFeature): FeatureAccess {
  if (!planHas(me, feature)) return "plan_locked";
  if (!lease) return "daemon_needed";
  return lease.features.includes(feature) ? "available" : "lease_missing";
}
