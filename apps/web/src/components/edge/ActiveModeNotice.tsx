"use client";

import Link from "next/link";
import { useState } from "react";
import { Banner, Button } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { useEdge } from "@/context/edge";
import { featureAccess } from "@/lib/entitlements";

/**
 * Explains why a confirmed action isn't possible right now, with the fix:
 * reconnect in Active mode, refresh the lease, or upgrade the plan.
 * Renders nothing when Active mode is on.
 */
export function ActiveModeNotice({ what }: { what: string }) {
  const { link, lease, connectAdapter, disconnectAdapter, ready } = useEdge();
  const { me } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ready || !link || link.state !== "CONNECTED") return null;
  if (link.safetyMode === "ACTIVE_CONFIRMED") return null;
  const access = featureAccess(me, lease, "UDS_ACTIVE");

  if (access === "plan_locked") {
    return (
      <Banner tone="info" title={`${what} needs Active diagnostics`} action={<Link href="/workshop/billing" className="text-sm font-semibold underline">See plans</Link>}>
        Your plan is read-only. Pro and higher can clear codes and run service functions, each with a safety confirmation.
      </Banner>
    );
  }
  if (access === "lease_missing" || access === "daemon_needed") {
    return (
      <Banner tone="warn" title={`${what} needs a fresh lease on this computer`} action={<Link href="/devices#lease" className="text-sm font-semibold underline">Refresh lease</Link>}>
        Your plan includes Active diagnostics, but the daemon&apos;s lease doesn&apos;t yet.
      </Banner>
    );
  }
  return (
    <Banner
      tone="info"
      title="The vehicle is connected read-only (Silent)"
      action={
        <Button
          size="sm"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const id = link.adapterId;
            const protocol = link.protocol;
            try {
              await disconnectAdapter();
              await connectAdapter(id, { protocol, safetyMode: "ACTIVE_CONFIRMED" });
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Reconnect in Active mode
        </Button>
      }
    >
      {what} needs Active mode. Every action still asks for its own safety confirmation.
      {error ? <span className="mt-1 block text-danger-ink">{error}</span> : null}
    </Banner>
  );
}
