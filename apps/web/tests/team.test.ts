import { describe, expect, it } from "vitest";
import type { Team } from "../src/lib/api";
import { inviteExpiry, seatState } from "../src/lib/team";

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
  it("only owners can manage", () => {
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
