import type { AccreditationBlock, AccreditationOverview, Me } from "@/lib/api";
import { stateView } from "@/lib/accreditation";
import { TIER_LABEL } from "@/lib/entitlements";

/**
 * The "Licences & access" checklist: what RootCause supplies with the plan, and
 * what a workshop or technician has to get from someone else (AASRA, carmakers,
 * AutoAuth). RootCause can't sell those: MVIS restricts security information to
 * vetted individuals, and secure-gateway access is tied to the technician's own
 * account. See docs/runbooks/licensing-setup.md.
 */

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";
export type Source = "rootcause" | "aasra" | "carmaker" | "autoauth";

export interface LicenceItem {
  id: "plan" | "workshop_aasra" | "technician" | "oem_info" | "secure_gateway" | "android";
  title: string;
  /** Who you get it from. */
  source: Source;
  /** Who pays for it. */
  paidTo: string;
  /** What it unlocks in RootCause. */
  unlocks: string;
  badge: string;
  tone: Tone;
  /** One line on the current state, or on what to do next. */
  detail: string;
  /** In-app link to act on it, if there is one. */
  action?: { label: string; href: string };
  /** Only some work needs it (e.g. key programming). */
  optional?: boolean;
}

export const SOURCE_LABEL: Record<Source, string> = {
  rootcause: "Included with RootCause",
  aasra: "From AASRA",
  carmaker: "From each carmaker",
  autoauth: "From AutoAuth",
};

const BILLING_PROBLEM = new Set(["past_due", "unpaid", "incomplete"]);

function planItem(me: Me): LicenceItem {
  const e = me.entitlements;
  const label = TIER_LABEL[e.tier];
  const owner = me.workspace.role === "OWNER";
  const problem = e.billing_status ? BILLING_PROBLEM.has(e.billing_status) : false;
  let detail: string;
  if (problem) {
    detail = "There's a problem with the payment. Paid features stop when the grace period ends.";
  } else if (e.tier === "COMMUNITY") {
    detail = "Free plan: reading codes and live data. Upgrade to clear codes and run service functions.";
  } else if (e.billing_status === "trialing" && e.trial_ends_at) {
    detail = `${label} trial. Your devices pick up the plan automatically when they renew their licence.`;
  } else {
    detail = `${label} plan for ${e.seats} technician${e.seats === 1 ? "" : "s"}. Your devices and the Android app pick it up automatically.`;
  }
  return {
    id: "plan",
    title: "RootCause plan",
    source: "rootcause",
    paidTo: "RootCause (monthly or yearly)",
    unlocks: "The software licence: active diagnostics, CAN Studio, J2534, AI diagnoses.",
    badge: problem ? "Payment overdue" : label,
    tone: problem ? "danger" : e.tier === "COMMUNITY" ? "neutral" : "ok",
    detail,
    action: owner ? { label: "Plan & billing", href: "/workshop/billing" } : undefined,
  };
}

function fromAccreditation(block: AccreditationBlock | undefined, who: "technician" | "workshop") {
  if (!block) return { badge: "Unknown", tone: "neutral" as Tone, detail: "Couldn't load the status." };
  const v = stateView(block, who);
  return { badge: v.badge, tone: v.tone, detail: v.title };
}

export function licenceChecklist(me: Me, accreditation: AccreditationOverview | null): LicenceItem[] {
  const canSubmitWorkshop = me.workspace.permissions?.includes("SUBMIT_WORKSHOP_ACCREDITATION") ?? false;
  const workshop = fromAccreditation(accreditation?.workshop, "workshop");
  const tech = fromAccreditation(accreditation?.technician, "technician");
  const immoOn = me.immo_feature_enabled;

  return [
    planItem(me),
    {
      id: "workshop_aasra",
      title: "Workshop AASRA membership",
      source: "aasra",
      paidTo: "AASRA, yearly (not RootCause)",
      unlocks: "Security-related work such as key programming. Also gives you AASRA's portal to buy carmaker repair information.",
      badge: workshop.badge,
      tone: workshop.tone,
      detail:
        accreditation?.workshop.state === "not_submitted"
          ? "Join AASRA, then send your member number and ABN to RootCause so we can check it."
          : workshop.detail,
      action: canSubmitWorkshop ? { label: "Send AASRA details", href: "/workshop#accreditation" } : undefined,
      optional: true,
    },
    {
      id: "technician",
      title: "Your technician security accreditation",
      source: "aasra",
      paidTo: "AASRA, per technician, yearly (not RootCause)",
      unlocks: "Key programming and other vehicle-security jobs. Each technician needs their own; it can't be shared.",
      badge: tech.badge,
      tone: tech.tone,
      detail:
        accreditation?.technician.state === "not_submitted"
          ? "Add AASRA's security upgrade to your membership (it includes a police check), then send it to RootCause."
          : tech.detail,
      action: immoOn ? { label: "Send your accreditation", href: "/key-programming" } : undefined,
      optional: true,
    },
    {
      id: "oem_info",
      title: "Carmaker repair information",
      source: "carmaker",
      paidTo: "Each carmaker, per day, month or year",
      unlocks: "Factory wiring diagrams and procedures. Upload the diagrams you buy to RootCause; they stay private to your workshop.",
      badge: "Buy direct",
      tone: "neutral",
      detail: "RootCause doesn't resell carmaker information. Buy it from the carmaker's site or through AASRA's portal.",
      action: { label: "Upload wiring diagrams", href: "/knowledge" },
      optional: true,
    },
    {
      id: "secure_gateway",
      title: "Secure gateway access (Jeep, RAM, Nissan, Mercedes-Benz)",
      source: "autoauth",
      paidTo: "AutoAuth, plus any carmaker fee",
      unlocks: "Clearing codes and service functions on vehicles with a locked gateway. Reading codes works without it.",
      badge: "Not available yet",
      tone: "info",
      detail:
        "RootCause is applying to be an approved tool. Until then these gateways stay locked; there's nothing to buy yet.",
      optional: true,
    },
    {
      id: "android",
      title: "Android app",
      source: "rootcause",
      paidTo: "Nothing extra",
      unlocks: "The same plan on a phone or tablet with a Bluetooth OBD-II adapter.",
      badge: "Included",
      tone: "ok",
      detail: "Sign in with this account. Plans are managed here on the website, not in the app.",
    },
  ];
}
