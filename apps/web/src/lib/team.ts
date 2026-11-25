import type { Team } from "@/lib/api";

export interface SeatState {
  /** Members plus open (unexpired) invites. */
  held: number;
  free: number;
  /** More members than the plan includes (after a downgrade). Existing members keep access. */
  over: boolean;
  canInvite: boolean;
  canAddSite: boolean;
}

export function seatState(team: Team): SeatState {
  const held = team.seats.used + team.seats.pending;
  return {
    held,
    free: Math.max(0, team.seats.limit - held),
    over: team.seats.used > team.seats.limit,
    canInvite: team.can_manage && held < team.seats.limit,
    canAddSite: team.can_manage && team.sites_cap.used < team.sites_cap.limit,
  };
}

/** "Expires in 6 days" / "Expired" for an invite, relative to now. */
export function inviteExpiry(expiresAt: string, now = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "Expired";
  const h = Math.round(ms / 3_600_000);
  if (h < 24) return `Expires in ${Math.max(1, h)} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `Expires in ${d} day${d === 1 ? "" : "s"}`;
}
