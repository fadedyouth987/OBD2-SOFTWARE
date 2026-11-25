"use client";

import Link from "next/link";
import { Badge, Banner, Button, Card, EmptyState } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { useEdge } from "@/context/edge";
import { FEATURE_INFO, TIER_LABEL } from "@/lib/entitlements";
import { formatDateTime, relative } from "@/lib/format";
import type { LeaseFeature } from "@/lib/api";

const ALL: LeaseFeature[] = ["UDS_ACTIVE", "CAN_RE_PRO", "J2534", "IMMO_PROGRAM"];

export function LeaseCard() {
  const { lease, ready, mode, syncLease, leaseSync } = useEdge();
  const { me } = useAuth();

  if (!ready || !lease) {
    return (
      <Card id="lease" title="Offline lease" subtitle="What the daemon is allowed to do, even without internet.">
        <EmptyState title="Connect the daemon to see its lease" />
      </Card>
    );
  }
  const planTier = me?.entitlements.tier ?? "COMMUNITY";
  const mismatch = lease.lease_tier !== planTier;
  const exp = lease.expires_at ? new Date(lease.expires_at) : null;

  return (
    <Card
      id="lease"
      title="Offline lease"
      subtitle="What the daemon is allowed to do, even without internet. Leases last up to 72 hours and renew when you're online."
      actions={
        mode === "daemon" && lease.cloud_keys_pinned ? (
          <Button size="sm" busy={leaseSync.status === "syncing"} onClick={() => void syncLease()}>
            Refresh lease now
          </Button>
        ) : null
      }
    >
      <div className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted">Daemon lease</dt>
            <dd className="font-semibold">{TIER_LABEL[lease.lease_tier]}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Workshop plan</dt>
            <dd className="font-semibold">{TIER_LABEL[planTier]}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Lease ends</dt>
            <dd className="font-semibold">{exp ? `${formatDateTime(exp)} (${relative(exp)})` : "Never (built-in read-only tier)"}</dd>
          </div>
          {lease.immo_expires_at ? (
            <div>
              <dt className="text-xs text-muted">Key-programming lease ends</dt>
              <dd className="font-semibold">{formatDateTime(lease.immo_expires_at)}</dd>
            </div>
          ) : null}
        </dl>
        <ul className="grid gap-2 sm:grid-cols-2">
          {ALL.map((f) => {
            const on = lease.features.includes(f);
            return (
              <li key={f} className="flex items-start gap-2 rounded-lg border border-line p-2.5">
                <Badge tone={on ? "ok" : "neutral"}>{on ? "On" : "Off"}</Badge>
                <div>
                  <p className="text-sm font-semibold">{FEATURE_INFO[f].label}</p>
                  <p className="text-xs text-muted">{FEATURE_INFO[f].what}</p>
                  {!on ? <p className="mt-0.5 text-xs text-faint">Needs {FEATURE_INFO[f].plan}.</p> : null}
                </div>
              </li>
            );
          })}
        </ul>

        {mode === "browser-sim" ? (
          <Banner tone="info">The browser demo always runs read-only. Connect the real daemon to use your plan.</Banner>
        ) : !lease.cloud_keys_pinned ? (
          <Banner tone="warn" title="This daemon can't take cloud leases">
            It has no RootCause cloud key built in, so it stays on the free read-only tier whatever your plan is.
            Install the production edge daemon to use paid features.
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer">For developers</summary>
              Debug builds can trust the local API&apos;s key: set EDGE_DEV_CLOUD_KEYS from
              scripts/dev_cloud_keys.py and restart the daemon. Release builds ignore it.
            </details>
          </Banner>
        ) : leaseSync.status === "error" ? (
          <Banner tone="danger" title="Couldn't refresh the lease">
            {leaseSync.message}
          </Banner>
        ) : mismatch ? (
          <Banner tone="warn" title={`Your plan is ${TIER_LABEL[planTier]}, but the daemon has a ${TIER_LABEL[lease.lease_tier]} lease`}>
            {planTier === "COMMUNITY"
              ? "The lease will drop to Community when it ends."
              : "Refresh the lease to unlock your plan's features on this computer."}
          </Banner>
        ) : leaseSync.status === "ok" ? (
          <Banner tone="ok">Lease refreshed {leaseSync.at ? relative(leaseSync.at) : ""}.</Banner>
        ) : null}
        {planTier === "COMMUNITY" ? (
          <p className="text-sm text-muted">
            Want clearing codes, service functions or CAN Studio?{" "}
            <Link href="/workshop/billing" className="font-semibold text-text underline">
              Compare plans
            </Link>
          </p>
        ) : null}
      </div>
    </Card>
  );
}
