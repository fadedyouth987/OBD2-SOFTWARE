import { describe, expect, it } from "vitest";
import type { AccreditationBlock, AccreditationOverview, Me, PlanTier } from "@/lib/api";
import { licenceChecklist } from "@/lib/licences";

function me(over: { tier?: PlanTier; billing_status?: string | null; role?: string; permissions?: string[]; immo?: boolean } = {}): Me {
  return {
    user: { id: "u", email: "a@b.au", display_name: "A", last_login_at: null },
    workspace: {
      tenant_id: "t",
      name: "Shop",
      role: over.role ?? "OWNER",
      aasra_verified: false,
      permissions: (over.permissions ?? ["MANAGE_BILLING", "SUBMIT_WORKSHOP_ACCREDITATION"]) as never,
    },
    workspaces: [],
    entitlements: {
      tier: over.tier ?? "WORKSHOP",
      stored_tier: over.tier ?? "WORKSHOP",
      billing_status: over.billing_status === undefined ? "active" : over.billing_status,
      immo_entitled: false,
      lease_version: 0,
      ai_diagnoses: 400,
      schematic_pages: 100,
      seats: 5,
      sites: 1,
      features: ["UDS_ACTIVE"],
      billing_grace_until: null,
      trial_ends_at: null,
      trial_used: false,
    },
    usage: { ai_diagnoses_used: 0, schematic_pages_used: 0, quota_period_start: null, quota_timezone: "Australia/Adelaide" },
    immo_feature_enabled: over.immo ?? false,
    dev_login_enabled: false,
  };
}

const block = (state: AccreditationBlock["state"]): AccreditationBlock => ({ state, current: null, pending: null, latest: null });
const overview = (workshop: AccreditationBlock["state"], technician: AccreditationBlock["state"]): AccreditationOverview => ({
  workshop: block(workshop),
  technician: block(technician),
  evidence_rules: { max_files: 5, max_bytes: 1, types: [] },
  reminder_days: [30, 7],
  dev_auto_approve: false,
});

const byId = (items: ReturnType<typeof licenceChecklist>) => Object.fromEntries(items.map((i) => [i.id, i]));

describe("licenceChecklist", () => {
  it("lists what RootCause supplies separately from what's bought elsewhere", () => {
    const items = licenceChecklist(me(), overview("not_submitted", "not_submitted"));
    const sources = byId(items);
    expect(sources.plan.source).toBe("rootcause");
    expect(sources.android.source).toBe("rootcause");
    expect(sources.workshop_aasra.source).toBe("aasra");
    expect(sources.technician.source).toBe("aasra");
    expect(sources.oem_info.source).toBe("carmaker");
    expect(sources.secure_gateway.source).toBe("autoauth");
    // Third-party access is never presented as something RootCause sells.
    for (const i of items.filter((x) => x.source !== "rootcause")) {
      expect(i.paidTo).not.toMatch(/^RootCause/);
    }
  });

  it("shows the plan, and flags a payment problem", () => {
    expect(byId(licenceChecklist(me(), null)).plan).toMatchObject({ badge: "Workshop", tone: "ok" });
    expect(byId(licenceChecklist(me({ billing_status: "past_due" }), null)).plan).toMatchObject({ badge: "Payment overdue", tone: "danger" });
    expect(byId(licenceChecklist(me({ tier: "COMMUNITY", billing_status: null }), null)).plan.tone).toBe("neutral");
  });

  it("only offers billing and workshop submission to people allowed to do them", () => {
    const owner = byId(licenceChecklist(me(), null));
    expect(owner.plan.action?.href).toBe("/workshop/billing");
    expect(owner.workshop_aasra.action?.href).toBe("/workshop#accreditation");
    const tech = byId(licenceChecklist(me({ role: "TECH", permissions: [] }), null));
    expect(tech.plan.action).toBeUndefined();
    expect(tech.workshop_aasra.action).toBeUndefined();
  });

  it("uses live accreditation status", () => {
    const items = byId(licenceChecklist(me(), overview("approved", "pending")));
    expect(items.workshop_aasra.badge).toBe("Approved");
    expect(items.technician.badge).toBe("In review");
    const fresh = byId(licenceChecklist(me(), overview("not_submitted", "not_submitted")));
    expect(fresh.workshop_aasra.detail).toMatch(/Join AASRA/);
  });

  it("says secure gateway access isn't available yet rather than offering it", () => {
    const gw = byId(licenceChecklist(me(), null)).secure_gateway;
    expect(gw.badge).toBe("Not available yet");
    expect(gw.action).toBeUndefined();
  });

  it("links technician accreditation only when key programming is switched on", () => {
    expect(byId(licenceChecklist(me({ immo: false }), null)).technician.action).toBeUndefined();
    expect(byId(licenceChecklist(me({ immo: true }), null)).technician.action?.href).toBe("/key-programming");
  });

  it("copes with accreditation status that failed to load", () => {
    const items = byId(licenceChecklist(me(), null));
    expect(items.workshop_aasra.badge).toBe("Unknown");
  });
});
