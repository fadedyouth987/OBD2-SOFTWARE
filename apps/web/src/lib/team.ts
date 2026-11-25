import { ROLE_LABEL, type Team, type TeamAbilities, type TeamAuditEvent, type TeamRole } from "@/lib/api";

export interface SeatState {
  /** Members plus open (unexpired) invites. */
  held: number;
  free: number;
  /** More members than the plan includes (after a downgrade). Existing members keep access. */
  over: boolean;
  canInvite: boolean;
  canAddSite: boolean;
}

const NONE: TeamAbilities = {
  invite: false,
  invite_roles: [],
  revoke_invites: false,
  change_roles: false,
  remove_members: false,
  manage_sites: false,
  transfer_ownership: false,
  view_history: false,
};

/** What the signed-in user may do on the team. Falls back to `can_manage` for older APIs. */
export function abilities(team: Team): TeamAbilities {
  if (team.abilities) return team.abilities;
  if (!team.can_manage) return NONE;
  return {
    invite: true,
    invite_roles: ["TECH", "LEAD_TECH"],
    revoke_invites: true,
    change_roles: true,
    remove_members: true,
    manage_sites: true,
    transfer_ownership: true,
    view_history: true,
  };
}

export function seatState(team: Team): SeatState {
  const a = abilities(team);
  const held = team.seats.used + team.seats.pending;
  return {
    held,
    free: Math.max(0, team.seats.limit - held),
    over: team.seats.used > team.seats.limit,
    canInvite: a.invite && held < team.seats.limit,
    canAddSite: a.manage_sites && team.sites_cap.used < team.sites_cap.limit,
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

function roleName(value: unknown): string {
  return typeof value === "string" && value in ROLE_LABEL ? ROLE_LABEL[value as TeamRole].toLowerCase() : "member";
}

/** One line for the team history list, e.g. "Sam invited jo@example.com as technician". */
export function describeAuditEvent(e: TeamAuditEvent): string {
  const who = e.actor ?? "Someone";
  const whom = e.subject ?? "someone";
  const d = e.detail ?? {};
  switch (e.action) {
    case "invite_created":
      return `${who} invited ${whom} as ${roleName(d.role)}`;
    case "invite_resent":
      return `${who} re-sent the invite to ${whom}`;
    case "invite_revoked":
      return `${who} revoked the invite for ${whom}`;
    case "invite_accepted":
      return `${whom} joined as ${roleName(d.role)}`;
    case "member_role_changed":
      return `${who} changed ${whom} from ${roleName(d.before)} to ${roleName(d.after)}`;
    case "member_site_changed":
      return d.site ? `${who} moved ${whom} to ${String(d.site)}` : `${who} cleared ${whom}'s site`;
    case "member_removed":
      return `${who} removed ${whom} (${roleName(d.role)})`;
    case "site_created":
      return `${who} added the site ${String(d.site ?? "")}`.trim();
    case "site_renamed":
      return `${who} renamed ${String(d.before ?? "a site")} to ${String(d.after ?? "")}`.trim();
    case "site_deleted":
      return `${who} deleted the site ${String(d.site ?? "")}`.trim();
    case "ownership_offered":
      return `${who} offered ownership to ${whom}`;
    case "ownership_offer_cancelled":
      return `${who} cancelled the ownership offer to ${whom}`;
    case "ownership_offer_declined":
      return `${who} declined ownership`;
    case "ownership_offer_expired":
      return `The ownership offer to ${whom} expired`;
    case "ownership_transferred":
      return `${who} accepted ownership; ${whom} is now a lead technician`;
    default:
      return `${who}: ${e.action.replace(/_/g, " ")}`;
  }
}

/** Workshop-name check for the ownership hand-over, same rule as the API. */
export function confirmNameMatches(typed: string, workshop: string): boolean {
  const norm = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(typed) !== "" && norm(typed) === norm(workshop);
}
