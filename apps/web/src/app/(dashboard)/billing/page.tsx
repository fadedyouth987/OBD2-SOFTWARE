"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

const CLOUD_API_URL = process.env.NEXT_PUBLIC_CLOUD_API_URL ?? "http://127.0.0.1:8000";
const SESSION_KEY = "rootcause.session";

interface TierCard {
  tier: string;
  display_name: string;
  monthly_price_aud: number;
  annual_price_aud: number;
  annual_is_10_for_12: boolean;
  ai_diagnoses: number;
  schematic_pages: number;
  seats: number;
  sites: number;
  features: string[];
  description: string;
  immo_addon_available: boolean;
}

interface Catalog {
  currency: string;
  timezone: string;
  overage_aud: number;
  overage_enabled: boolean;
  trial_days: number;
  trial_requires_card: boolean;
  immo_addon: { monthly_price_aud: number; annual_price_aud: number; description: string };
  tiers: TierCard[];
}

interface BillingState extends Catalog {
  tier?: string;
  stored_tier?: string;
  billing_status?: string;
  immo_entitled?: boolean;
  ai_diagnoses_used?: number;
  schematic_pages_used?: number;
  role?: string;
  has_stripe_customer?: boolean;
  trial_used?: boolean;
}

const FEATURE_LABEL: Record<string, string> = {
  UDS_ACTIVE: "Active UDS",
  CAN_RE_PRO: "CAN reverse-engineering",
  J2534: "J2534 PassThru",
};

export default function BillingPage() {
  const [sessionToken, setSessionToken] = useState("");
  const [catalog, setCatalog] = useState<BillingState | null>(null);
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [immoAddon, setImmoAddon] = useState(false);
  const [startTrial, setStartTrial] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      setSessionToken(window.localStorage.getItem(SESSION_KEY) ?? "");
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async (token: string) => {
    try {
      const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${CLOUD_API_URL}/api/v1/billing${token ? "" : "/tiers"}`, { headers });
      if (res.status === 401) {
        const pub = await fetch(`${CLOUD_API_URL}/api/v1/billing/tiers`);
        setCatalog((await pub.json()) as Catalog);
        return;
      }
      if (!res.ok) {
        setHint(`Could not load billing (${res.status})`);
        return;
      }
      setCatalog((await res.json()) as BillingState);
    } catch {
      setHint("Cloud API offline on :8000 — start uvicorn to load plans.");
    }
  }, []);

  useEffect(() => {
    void load(sessionToken);
  }, [sessionToken, load]);

  const authHeaders = (): HeadersInit => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
    return headers;
  };

  const checkout = async (tier: string) => {
    setBusy(true);
    setHint(null);
    try {
      const res = await fetch(`${CLOUD_API_URL}/api/v1/billing/checkout-session`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          tier,
          interval,
          immo_addon: immoAddon && (tier === "WORKSHOP" || tier === "FLEET"),
          start_trial: startTrial && tier === "WORKSHOP" && interval === "month",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setHint(typeof data.detail === "string" ? data.detail : `Checkout failed (${res.status})`);
        return;
      }
      if (data.checkout_url) {
        window.location.href = data.checkout_url as string;
      }
    } catch {
      setHint("Cloud API offline on :8000.");
    } finally {
      setBusy(false);
    }
  };

  const openPortal = async () => {
    setBusy(true);
    setHint(null);
    try {
      const res = await fetch(`${CLOUD_API_URL}/api/v1/billing/customer-portal`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setHint(typeof data.detail === "string" ? data.detail : `Portal failed (${res.status})`);
        return;
      }
      if (data.portal_url) window.location.href = data.portal_url as string;
    } catch {
      setHint("Cloud API offline on :8000.");
    } finally {
      setBusy(false);
    }
  };

  const isOwner = catalog?.role === "OWNER";

  return (
    <main className="min-h-screen bg-[#0c0f14] p-4 text-slate-100 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold">Plans &amp; billing</h1>
            <p className="text-xs text-slate-400">
              Prices in AUD. Annual is 10-for-12. Quotas reset on the calendar month in Australia/Adelaide.
              AI overage (A${catalog?.overage_aud ?? 0.25}/diagnosis) is metered but off by default.
            </p>
          </div>
          <Link href="/" className="flex min-h-[44px] items-center rounded-xl bg-[#e0242f] px-4 text-xs font-bold text-white">
            Back to console
          </Link>
        </div>

        {catalog?.tier && (
          <div className="rounded-xl border border-slate-800 bg-[#151a22] p-3 text-xs">
            Current plan: <strong>{catalog.tier}</strong>
            {catalog.billing_status ? ` · ${catalog.billing_status}` : ""}
            {catalog.immo_entitled ? " · IMMO add-on active" : ""}
            {typeof catalog.ai_diagnoses_used === "number" && (
              <>
                {" "}
                · AI {catalog.ai_diagnoses_used}/
                {catalog.tiers.find((t) => t.tier === catalog.tier)?.ai_diagnoses ?? "—"}
              </>
            )}
          </div>
        )}

        {hint && <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">{hint}</div>}

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-2">
            <span>Billing interval</span>
            <select
              value={interval}
              onChange={(e) => setInterval(e.target.value as "month" | "year")}
              className="min-h-[44px] rounded-xl border border-slate-700 bg-slate-900 px-3"
            >
              <option value="month">Monthly</option>
              <option value="year">Annual (10 months for 12)</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={immoAddon} onChange={(e) => setImmoAddon(e.target.checked)} />
            Include IMMO add-on (Workshop/Fleet, A${catalog?.immo_addon.monthly_price_aud ?? 49}/mo or A$
            {catalog?.immo_addon.annual_price_aud ?? 490}/yr)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={startTrial} onChange={(e) => setStartTrial(e.target.checked)} />
            14-day Workshop trial (card required)
          </label>
          {isOwner && catalog?.has_stripe_customer && (
            <button
              type="button"
              onClick={() => void openPortal()}
              disabled={busy}
              className="min-h-[44px] rounded-xl border border-slate-600 px-3 font-semibold"
            >
              Manage in Stripe
            </button>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {(catalog?.tiers ?? []).map((tier) => {
            const price = interval === "year" ? tier.annual_price_aud : tier.monthly_price_aud;
            const suffix = interval === "year" ? "/year" : "/month";
            const current = catalog?.tier === tier.tier;
            return (
              <section key={tier.tier} className="flex flex-col rounded-2xl border border-slate-800 bg-[#151a22] p-4">
                <h2 className="text-sm font-bold text-white">{tier.display_name}</h2>
                <p className="mt-1 text-2xl font-extrabold">
                  {price === 0 ? "Free" : `A$${price.toLocaleString("en-AU")}`}
                  {price > 0 && <span className="text-xs font-normal text-slate-400">{suffix}</span>}
                </p>
                <p className="mt-2 text-xs text-slate-400">{tier.description}</p>
                <ul className="mt-3 space-y-1 text-xs text-slate-300">
                  <li>{tier.seats} seat{tier.seats === 1 ? "" : "s"} · {tier.sites} site{tier.sites === 1 ? "" : "s"}</li>
                  <li>{tier.ai_diagnoses} AI diagnoses / month</li>
                  <li>
                    {tier.schematic_pages === 0
                      ? "No schematic pages"
                      : `${tier.schematic_pages} schematic pages / month`}
                  </li>
                  {tier.features.map((f) => (
                    <li key={f}>{FEATURE_LABEL[f] ?? f}</li>
                  ))}
                  {tier.immo_addon_available && <li>Optional IMMO add-on</li>}
                </ul>
                {tier.tier !== "COMMUNITY" && (
                  <button
                    type="button"
                    disabled={busy || !isOwner}
                    onClick={() => void checkout(tier.tier)}
                    className="mt-4 min-h-[44px] rounded-xl bg-blue-600 px-3 text-xs font-bold text-white disabled:opacity-40"
                  >
                    {current ? "Current plan" : !sessionToken ? "Sign in to subscribe" : isOwner ? "Subscribe" : "Owner only"}
                  </button>
                )}
              </section>
            );
          })}
        </div>

        <p className="text-xs text-slate-500">
          Immobilizer tooling stays gated by AASRA, technician accreditation, and OEM policy even with the add-on.
          {!sessionToken && " Sign in from the Live page to subscribe."}
        </p>
      </div>
    </main>
  );
}
