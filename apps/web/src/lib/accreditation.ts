import type { AccreditationBlock, AccreditationRequest } from "@/lib/api";
import { formatDate } from "@/lib/format";

export interface StateView {
  tone: "ok" | "warn" | "danger" | "info" | "neutral";
  badge: string;
  title: string;
  body: string;
  /** Show the submit form (first time, after a rejection/expiry, or to renew). */
  canSubmit: boolean;
}

const DAY = 86_400_000;

/** Days until an approval's expiry (negative once it's past). */
export function daysLeft(expiresAt: string | null | undefined, now = Date.now()): number | null {
  if (!expiresAt) return null;
  return Math.floor((new Date(expiresAt).getTime() - now) / DAY);
}

/** What to tell someone about their (or their workshop's) accreditation. */
export function stateView(block: AccreditationBlock, who: "technician" | "workshop", now = Date.now()): StateView {
  const subject = who === "technician" ? "Your accreditation" : "The workshop's AASRA verification";
  const cur: AccreditationRequest | null = block.current;
  const until = cur?.expires_at ? formatDate(cur.expires_at) : null;
  const left = daysLeft(cur?.expires_at, now);
  switch (block.state) {
    case "approved":
      return {
        tone: left !== null && left <= 30 ? "warn" : "ok",
        badge: "Approved",
        title: `${subject} is approved${until ? ` until ${until}` : ""}`,
        body:
          left !== null && left <= 30
            ? `It expires in ${Math.max(0, left)} day${left === 1 ? "" : "s"}. Send updated paperwork now so there's no gap.`
            : "We'll email a reminder 30 and 7 days before it expires.",
        canSubmit: left !== null && left <= 60,
      };
    case "renewal_pending":
      return {
        tone: "info",
        badge: "Renewal in review",
        title: `${subject} is approved${until ? ` until ${until}` : ""}; the renewal is being reviewed`,
        body: "You can keep working while it's reviewed.",
        canSubmit: false,
      };
    case "pending":
      return {
        tone: "info",
        badge: "In review",
        title: "Submitted, waiting for review",
        body: "A RootCause administrator checks the details and evidence against AASRA records. You'll get an email when it's decided.",
        canSubmit: false,
      };
    case "rejected":
      return {
        tone: "danger",
        badge: "Not approved",
        title: "The last submission wasn't approved",
        body: block.latest?.decision_reason ? `Reason: ${block.latest.decision_reason}` : "Fix the details and send it again.",
        canSubmit: true,
      };
    case "expired":
      return {
        tone: "warn",
        badge: "Expired",
        title: `${subject} has expired`,
        body: "Send current paperwork to be approved again.",
        canSubmit: true,
      };
    case "revoked":
      return {
        tone: "danger",
        badge: "Revoked",
        title: `${subject} was revoked`,
        body: block.latest?.decision_reason ? `Reason: ${block.latest.decision_reason}` : "Contact RootCause support.",
        canSubmit: true,
      };
    default:
      return {
        tone: "neutral",
        badge: "Not submitted",
        title: who === "technician" ? "You haven't submitted your accreditation" : "The workshop hasn't been verified",
        body:
          who === "technician"
            ? "Key programming needs your AASRA membership and a current police check or repairer licence, checked by a RootCause administrator."
            : "Security work such as key programming needs the workshop's AASRA membership checked by a RootCause administrator.",
        canSubmit: true,
      };
  }
}

/** Australian Business Number checksum (same rule as the API). */
export function validAbn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = digits.split("").reduce((acc, d, i) => acc + (Number(d) - (i === 0 ? 1 : 0)) * weights[i], 0);
  return sum % 89 === 0;
}

/** Client-side check of the chosen evidence files; the API checks again. */
export function evidenceProblem(files: File[], rules: { max_files: number; max_bytes: number; types: string[] }, required: boolean): string | null {
  if (required && files.length === 0) return "Attach your evidence: a PDF, PNG or JPEG of your AASRA card and police check or licence.";
  if (files.length > rules.max_files) return `Attach up to ${rules.max_files} files.`;
  const big = files.find((f) => f.size > rules.max_bytes);
  if (big) return `${big.name} is over ${Math.round(rules.max_bytes / 1_048_576)} MB.`;
  const odd = files.find((f) => f.type && !rules.types.includes(f.type));
  if (odd) return `${odd.name} isn't a PDF, PNG or JPEG.`;
  return null;
}
