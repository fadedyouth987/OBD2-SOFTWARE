import { describe, expect, it } from "vitest";
import type { Team } from "../src/lib/api";
import { abilities, confirmNameMatches, describeAuditEvent, inviteExpiry, seatState } from "../src/lib/team";

const team = (p: Partial<Team>): Team => ({
  can_manage: true,
  seats: { used: 1, pending: 0, limit: 5 },
  sites_cap: { used: 1, limit: 1 },
  members: [],
  invites: [],
  sites: [],
  ...p,
});

describe("seatState", () => {
  it("counts open invites against the cap", () => {
    expect(seatState(team({ seats: { used: 2, pending: 3, limit: 5 } }))).toMatchObject({ held: 5, free: 0, canInvite: false });
    expect(seatState(team({ seats: { used: 2, pending: 1, limit: 5 } }))).toMatchObject({ free: 2, canInvite: true });
  });
  it("flags a team over its plan after a downgrade", () => {
    expect(seatState(team({ seats: { used: 3, pending: 0, limit: 1 } }))).toMatchObject({ over: true, free: 0, canInvite: false });
  });
  it("without abilities nobody can manage", () => {
    expect(seatState(team({ can_manage: false, sites_cap: { used: 1, limit: 3 } }))).toMatchObject({ canInvite: false, canAddSite: false });
  });
});

describe("inviteExpiry", () => {
  const now = Date.parse("2026-11-25T00:00:00Z");
  it("reads naturally", () => {
    expect(inviteExpiry("2026-12-02T00:00:00Z", now)).toBe("Expires in 7 days");
    expect(inviteExpiry("2026-11-25T05:00:00Z", now)).toBe("Expires in 5 hours");
    expect(inviteExpiry("2026-11-24T00:00:00Z", now)).toBe("Expired");
  });
});

describe("lead technician abilities", () => {
  const lead = {
    invite: true,
    invite_roles: ["TECH" as const],
    revoke_invites: true,
    change_roles: false,
    remove_members: false,
    manage_sites: false,
    transfer_ownership: false,
    view_history: true,
  };
  it("can invite technicians but not add sites", () => {
    const s = seatState(team({ can_manage: false, abilities: lead, sites_cap: { used: 1, limit: 3 } }));
    expect(s).toMatchObject({ canInvite: true, canAddSite: false });
  });
  it("falls back to can_manage for older APIs", () => {
    expect(abilities(team({}))).toMatchObject({ invite_roles: ["TECH", "LEAD_TECH"], transfer_ownership: true });
    expect(abilities(team({ can_manage: false })).invite).toBe(false);
  });
});

describe("team history", () => {
  const ev = (action: string, detail: Record<string, unknown> = {}) => ({ id: 1, at: null, action, actor: "Sam", subject: "Jo", detail });
  it("describes events in plain English", () => {
    expect(describeAuditEvent(ev("invite_created", { role: "TECH" }))).toBe("Sam invited Jo as technician");
    expect(describeAuditEvent(ev("member_role_changed", { before: "TECH", after: "LEAD_TECH" }))).toBe(
      "Sam changed Jo from technician to lead technician",
    );
    expect(describeAuditEvent(ev("ownership_transferred"))).toBe("Sam accepted ownership; Jo is now a lead technician");
    expect(describeAuditEvent(ev("something_new"))).toBe("Sam: something new");
  });
  it("matches the workshop name like the API", () => {
    expect(confirmNameMatches("  north   YARD motors ", "North Yard Motors")).toBe(true);
    expect(confirmNameMatches("North Yard", "North Yard Motors")).toBe(false);
    expect(confirmNameMatches("", "")).toBe(false);
  });
});
