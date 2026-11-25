"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Badge, Banner, Button, Card, Meter, PageHeader, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { api, ApiError, type BillingState, type PlanTier, type TierInfo } from "@/lib/api";
import { FEATURE_INFO, TIER_LABEL } from "@/lib/entitlements";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";

const ORDER: PlanTier[] = ["COMMUNITY", "PRO", "WORKSHOP", "FLEET"];
const STATUS_TEXT: Record<string, [string, "ok" | "warn" | "danger" | "info"]> = {
  active: ["Active", "ok"],
  trialing: ["Trial", "info"],
  past_due: ["Payment overdue", "danger"],
  unpaid: ["Unpaid", "danger"],
  canceled: ["Cancelled", "warn"],
  incomplete: ["Payment incomplete", "warn"],
};

function aud(n: number) {
  return n === 0 ? "Free" : `A$${formatNumber(n)}`;
}

function BillingInner() {
  const { token, refresh } = useAuth();
  const params = useSearchParams();
  const [state, setState] = useState<BillingState | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [interval, setInterval_] = useState<"month" | "year">("month");
  const [immo, setImmo] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const checkout = params.get("checkout");

  const load = useCallback(async () => {
    try {
      const s = await api<BillingState>("/api/v1/billing", { token });
      setState(s);
      setLoadError(null);
      return s;
    } catch (e) {
      setLoadError(e instanceof ApiError ? e : new ApiError(0, String(e)));
      return null;
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // After Stripe returns, the webhook may land a few seconds later: poll briefly.
  useEffect(() => {
    if (checkout !== "success") return;
    let n = 0;
    const t = setInterval(async () => {
      n += 1;
      await load();
      await refresh();
      if (n >= 6) clearInterval(t);
    }, 3000);
    return () => clearInterval(t);
  }, [checkout, load, refresh]);

  const go = async (tier: PlanTier, trial: boolean) => {
    setBusy(`${tier}${trial ? "-trial" : ""}`);
    setActionError(null);
    try {
      const r = await api<{ checkout_url: string }>("/api/v1/billing/checkout-session", {
        token,
        body: {
          tier,
          interval: trial ? "month" : interval,
          immo_addon: immo && state!.immo_addon.eligible_tiers.includes(tier),
          start_trial: trial,
          success_url: "/workshop/billing?checkout=success",
          cancel_url: "/workshop/billing?checkout=cancel",
        },
      });
      window.location.assign(r.checkout_url);
    } catch (e) {
      setActionError(e instanceof ApiError ? (e.status === 503 ? `Online payments aren't set up on this server yet (${e.message}).` : e.message) : String(e));
      setBusy(null);
    }
  };

  const portal = async () => {
    setBusy("portal");
    setActionError(null);
    try {
      const r = await api<{ portal_url: string }>("/api/v1/billing/customer-portal", {
        token,
        body: { return_url: "/workshop/billing" },
      });
      window.location.assign(r.portal_url);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
      setBusy(null);
    }
  };

  if (loadError) {
    return (
      <Banner tone="danger" title="Couldn't load billing" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
        {loadError.offline ? "You're offline." : loadError.message}
      </Banner>
    );
  }
  if (!state) return <Skeleton className="h-96" />;

  const owner = state.role === "OWNER";
  const status = state.billing_status ? STATUS_TEXT[state.billing_status] : null;
  const tiers = [...state.tiers].sort((a, b) => ORDER.indexOf(a.tier) - ORDER.indexOf(b.tier));
  const currentIdx = ORDER.indexOf(state.tier);
  const canTrial = !state.trial_used && state.tier === "COMMUNITY";

  return (
    <div className="space-y-4">
      {checkout === "success" ? (
        <Banner tone="ok" title="Thanks, payment received">
          Your plan updates as soon as Stripe confirms it (usually a few seconds). Then refresh the lease on Devices to unlock features on the daemon.
        </Banner>
      ) : checkout === "cancel" ? (
        <Banner tone="neutral">Checkout cancelled. Nothing was charged.</Banner>
      ) : null}
      {actionError ? <Banner tone="danger">{actionError}</Banner> : null}
      {!owner ? <Banner tone="info">Only the workshop owner can change the plan. You can see what&apos;s included below.</Banner> : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card
          title={`${TIER_LABEL[state.tier]} plan`}
          subtitle={state.stored_tier !== state.tier ? `Billed as ${TIER_LABEL[state.stored_tier]}; running as ${TIER_LABEL[state.tier]} until billing is fixed.` : undefined}
          actions={
            owner && state.has_stripe_customer ? (
              <Button size="sm" variant="ghost" busy={busy === "portal"} onClick={() => void portal()}>
                Invoices & payment method
              </Button>
            ) : null
          }
        >
          <div className="space-y-2 text-sm">
            <p className="flex flex-wrap gap-2">
              {status ? <Badge tone={status[1]}>{status[0]}</Badge> : <Badge>No subscription</Badge>}
              {state.immo_entitled ? <Badge tone="accent">IMMO add-on</Badge> : null}
            </p>
            {state.trial_ends_at ? <p>Trial ends {formatDate(state.trial_ends_at)}.</p> : null}
            {state.billing_grace_until ? <p className="text-danger">Paid features stay on until {formatDateTime(state.billing_grace_until)}.</p> : null}
            <p className="text-muted">
              {state.seats} seat{state.seats === 1 ? "" : "s"} · {state.sites} site{state.sites === 1 ? "" : "s"}
            </p>
            <ul className="space-y-1">
              {(Object.keys(FEATURE_INFO) as (keyof typeof FEATURE_INFO)[]).map((f) => {
                const on = f === "IMMO_PROGRAM" ? state.immo_entitled : state.features.includes(f);
                return (
                  <li key={f} className="flex items-center gap-2">
                    <Badge tone={on ? "ok" : "neutral"}>{on ? "Included" : "Locked"}</Badge>
                    {FEATURE_INFO[f].label}
                  </li>
                );
              })}
            </ul>
          </div>
        </Card>
        <Card title="Usage this month" subtitle={`Resets on the 1st (${state.quota_timezone.replace("_", " ")} time).`}>
          <div className="space-y-3">
            <Meter label="AI diagnoses & questions" used={state.ai_diagnoses_used} limit={state.ai_diagnoses} />
            <Meter label="Schematic pages" used={state.schematic_pages_used} limit={state.schematic_pages} />
          </div>
        </Card>
      </div>

      <Card
        title="Plans"
        subtitle="Prices in AUD. Annual is 10 months' price for 12."
        actions={
          <div role="radiogroup" aria-label="Billing interval" className="flex rounded-lg border border-line p-0.5">
            {(["month", "year"] as const).map((i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={interval === i}
                onClick={() => setInterval_(i)}
                className={`min-h-[36px] rounded-md px-3 text-sm font-semibold ${interval === i ? "bg-raised text-text" : "text-muted"}`}
              >
                {i === "month" ? "Monthly" : "Annual"}
              </button>
            ))}
          </div>
        }
      >
        <div className="space-y-4">
          <label className="flex min-h-[44px] items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={immo} onChange={(e) => setImmo(e.target.checked)} />
            <span>
              Add key programming (IMMO add-on) · {aud(interval === "year" ? state.immo_addon.annual_price_aud : state.immo_addon.monthly_price_aud)}/
              {interval === "year" ? "year" : "month"}
              <span className="block text-xs text-muted">
                {state.immo_addon.description} Available on {state.immo_addon.eligible_tiers.map((t) => TIER_LABEL[t]).join(" and ")}.
              </span>
            </span>
          </label>
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {tiers.map((t: TierInfo) => {
              const price = interval === "year" ? t.annual_price_aud : t.monthly_price_aud;
              const current = t.tier === state.tier;
              const idx = ORDER.indexOf(t.tier);
              return (
                <li key={t.tier} className={`flex flex-col rounded-xl border p-4 ${current ? "border-accent" : "border-line"} bg-raised`}>
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold">{t.display_name}</h3>
                    {current ? <Badge tone="accent">Current</Badge> : null}
                  </div>
                  <p className="mt-1 text-2xl font-extrabold">
                    {aud(price)}
                    {price ? <span className="text-xs font-normal text-muted">/{interval === "year" ? "year" : "month"}</span> : null}
                  </p>
                  <p className="mt-1 text-sm text-muted">{t.description}</p>
                  <ul className="mt-3 space-y-1 text-sm">
                    <li>
                      {t.seats} seat{t.seats === 1 ? "" : "s"} · {t.sites} site{t.sites === 1 ? "" : "s"}
                    </li>
                    <li>{t.ai_diagnoses} AI diagnoses / month</li>
                    <li>{t.schematic_pages ? `${t.schematic_pages} schematic pages / month` : "No schematic uploads"}</li>
                    {t.features.map((f) => (
                      <li key={f}>✓ {FEATURE_INFO[f]?.label ?? f}</li>
                    ))}
                    {immo && state.immo_addon.eligible_tiers.includes(t.tier) ? <li>✓ Key programming add-on</li> : null}
                  </ul>
                  <div className="mt-auto space-y-2 pt-4">
                    {t.tier === "COMMUNITY" ? null : current ? (
                      owner && state.has_stripe_customer ? (
                        <Button size="sm" variant="ghost" className="w-full" busy={busy === "portal"} onClick={() => void portal()}>
                          Change or cancel
                        </Button>
                      ) : null
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant={idx > currentIdx ? "primary" : "ghost"}
                          className="w-full"
                          disabled={!owner || !!busy}
                          busy={busy === t.tier}
                          onClick={() => void (state.has_stripe_customer && state.billing_status ? portal() : go(t.tier, false))}
                        >
                          {idx > currentIdx ? `Upgrade to ${t.display_name}` : `Switch to ${t.display_name}`}
                        </Button>
                        {t.tier === state.trial_tier && canTrial ? (
                          <Button size="sm" variant="ghost" className="w-full" disabled={!owner || !!busy} busy={busy === `${t.tier}-trial`} onClick={() => void go(t.tier, true)}>
                            Start {state.trial_days}-day free trial
                          </Button>
                        ) : null}
                      </>
                    )}
                  </div>
                  {t.tier === state.trial_tier && canTrial ? (
                    <p className="mt-2 text-xs text-faint">Trial is monthly{state.trial_requires_card ? " and needs a card" : ""}; cancel any time before it ends.</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </Card>
    </div>
  );
}

export default function BillingPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="Plan & billing" />
      <Suspense>
        <BillingInner />
      </Suspense>
    </div>
  );
}
