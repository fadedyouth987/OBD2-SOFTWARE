"use client";

import { useState } from "react";
import { TeamCard } from "@/components/team/TeamCard";
import { Badge, Banner, Button, ButtonLink, Card, PageHeader } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { TIER_LABEL } from "@/lib/entitlements";
import { formatDateTime } from "@/lib/format";

const ROLE: Record<string, string> = { OWNER: "Owner", LEAD_TECH: "Lead technician", TECH: "Technician" };

export default function WorkshopPage() {
  const { me, switchWorkspace } = useAuth();
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!me) return null;
  const e = me.entitlements;

  return (
    <>
      <PageHeader title="Workshop" subtitle={me.workspace.name} actions={<ButtonLink href="/workshop/billing">Plan & billing</ButtonLink>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="This workshop">
          <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Name</dt>
            <dd>{me.workspace.name}</dd>
            <dt className="text-muted">Your role</dt>
            <dd>{ROLE[me.workspace.role] ?? me.workspace.role}</dd>
            <dt className="text-muted">Plan</dt>
            <dd>
              {TIER_LABEL[e.tier]} · {e.seats} seat{e.seats === 1 ? "" : "s"}, {e.sites} site{e.sites === 1 ? "" : "s"}
            </dd>
            <dt className="text-muted">AASRA</dt>
            <dd>
              {me.workspace.aasra_verified ? (
                <Badge tone="ok">Verified</Badge>
              ) : (
                <>
                  <Badge>Not verified</Badge>
                  <span className="mt-1 block text-xs text-muted">
                    Needed for security-related work such as key programming. Verification is done through AASRA; contact support with your AASRA membership to have it recorded.
                  </span>
                </>
              )}
            </dd>
          </dl>
        </Card>
        <Card title="Your account">
          <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Name</dt>
            <dd>{me.user.display_name ?? "—"}</dd>
            <dt className="text-muted">Email</dt>
            <dd>{me.user.email ?? "—"}</dd>
            <dt className="text-muted">Last sign-in</dt>
            <dd>{me.user.last_login_at ? formatDateTime(me.user.last_login_at) : "—"}</dd>
          </dl>
        </Card>
        <TeamCard />
        {me.workspaces.length > 1 ? (
          <Card title="Your workshops" subtitle="Switch to work in another workshop you belong to.">
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <ul className="divide-y divide-line">
              {me.workspaces.map((w) => {
                const current = w.tenant_id === me.workspace.tenant_id;
                return (
                  <li key={w.tenant_id} className="flex min-h-[56px] items-center justify-between gap-3 py-2">
                    <span>
                      <span className="block font-semibold">{w.name}</span>
                      <span className="text-xs text-muted">
                        {ROLE[w.role] ?? w.role} · {TIER_LABEL[w.tier]}
                      </span>
                    </span>
                    {current ? (
                      <Badge tone="accent">Current</Badge>
                    ) : (
                      <Button
                        size="sm"
                        busy={switching === w.tenant_id}
                        onClick={async () => {
                          setSwitching(w.tenant_id);
                          setError(null);
                          try {
                            await switchWorkspace(w.tenant_id);
                          } catch (err) {
                            setError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setSwitching(null);
                          }
                        }}
                      >
                        Switch
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}
