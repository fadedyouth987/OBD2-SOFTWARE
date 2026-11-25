import type { AdminAccreditation } from "@/lib/api";
import { ApiError } from "@/lib/api";

export const MIN_REASON = 10;

/** Problems in a procedure import (422 `{message, errors[]}`), one per line. */
export function importProblems(e: unknown): { message: string; errors: { where: string; problem: string }[] } {
  if (e instanceof ApiError) {
    const d = e.detail as { message?: string; errors?: { where?: string; problem?: string }[] } | null;
    const errors = Array.isArray(d?.errors)
      ? d.errors.map((x) => ({ where: String(x.where ?? ""), problem: String(x.problem ?? "") }))
      : [];
    return { message: e.offline ? "You're offline. Nothing was imported." : e.message, errors };
  }
  return { message: e instanceof Error ? e.message : String(e), errors: [] };
}

/** The reason an applicant will read; same rule as the API. */
export function reasonProblem(reason: string): string | null {
  const cleaned = reason.split(/\s+/).filter(Boolean).join(" ");
  return cleaned.length < MIN_REASON ? `Give a reason the applicant can act on (${MIN_REASON}+ characters).` : null;
}

const EVENT_TEXT: Record<string, string> = {
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  revoked: "Revoked",
  expired: "Expired",
  superseded: "Replaced by a newer submission",
  reminder_sent: "Expiry reminder sent",
};

export function describeAccreditationEvent(ev: AdminAccreditation["events"][number]): string {
  const base = EVENT_TEXT[ev.event] ?? ev.event.replace(/_/g, " ");
  const d = ev.detail ?? {};
  if (ev.event === "approved" && d.dev_auto_approve) return `${base} automatically (dev auto-approve)`;
  if ((ev.event === "rejected" || ev.event === "revoked") && typeof d.reason === "string") return `${base}: ${d.reason}`;
  if (ev.event === "submitted" && typeof d.evidence_files === "number")
    return `${base} with ${d.evidence_files} evidence file${d.evidence_files === 1 ? "" : "s"}`;
  if (ev.event === "reminder_sent" && typeof d.days_left === "number") return `${base} (${d.days_left} days before expiry)`;
  return base;
}
