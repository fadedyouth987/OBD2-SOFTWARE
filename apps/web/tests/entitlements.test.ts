import { describe, expect, it } from "vitest";
import { featureAccess, planHas } from "@/lib/entitlements";
import type { Me } from "@/lib/api";

const me = (features: string[], immo = false) =>
  ({ entitlements: { features, immo_entitled: immo } }) as unknown as Me;
const lease = (features: string[]) => ({ type: "LeaseStatus", request_id: "r", lease_tier: "PRO", features, expires_at: null, immo_expires_at: null, cloud_keys_pinned: true }) as never;

describe("featureAccess", () => {
  it("locks features the plan doesn't include", () => {
    expect(featureAccess(me([]), lease(["UDS_ACTIVE"]), "UDS_ACTIVE")).toBe("plan_locked");
  });
  it("needs a daemon to check the lease, and a lease that carries the feature", () => {
    expect(featureAccess(me(["UDS_ACTIVE"]), null, "UDS_ACTIVE")).toBe("daemon_needed");
    expect(featureAccess(me(["UDS_ACTIVE"]), lease([]), "UDS_ACTIVE")).toBe("lease_missing");
    expect(featureAccess(me(["UDS_ACTIVE"]), lease(["UDS_ACTIVE"]), "UDS_ACTIVE")).toBe("available");
  });
  it("treats key programming as the IMMO add-on", () => {
    expect(planHas(me(["UDS_ACTIVE"], true), "IMMO_PROGRAM")).toBe(true);
    expect(planHas(me(["UDS_ACTIVE"], false), "IMMO_PROGRAM")).toBe(false);
    expect(planHas(null, "UDS_ACTIVE")).toBe(false);
  });
});
