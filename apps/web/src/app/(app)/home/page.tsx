"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, Banner, ButtonLink, Card, EmptyState, Meter, PageHeader, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { useEdge } from "@/context/edge";
import { api, ApiError, type JobList } from "@/lib/api";
import { TIER_LABEL } from "@/lib/entitlements";
import { formatDateTime, relative } from "@/lib/format";

function Step({ done, title, children, href, cta }: { done: boolean; title: string; children: React.ReactNode; href?: string; cta?: string }) {
  return (
    <li className="flex gap-3 rounded-lg border border-line bg-raised p-3">
      <span aria-hidden className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${done ? "bg-ok text-bg" : "border border-line text-muted"}`}>
        {done ? "✓" : ""}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {title} <span className="sr-only">{done ? "(done)" : "(to do)"}</span>
        </p>
        <p className="text-sm text-muted">{children}</p>
      </div>
      {!done && href ? (
        <ButtonLink href={href} size="sm" className="self-center">
          {cta}
        </ButtonLink>
      ) : null}
    </li>
  );
}

export default function HomePage() {
  const { me, token } = useAuth();
  const edge = useEdge();
  const [open, setOpen] = useState<JobList | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<JobList>("/api/v1/jobs?status=OPEN&limit=6", { token })
      .then((o) => {
        setOpen(o);
        setTotal(o.open + o.closed);
      })
      .catch((e) => setError(e instanceof ApiError ? e : new ApiError(0, String(e))));
  }, [token]);

  if (!me) return null;
  const name = me.user.display_name?.split(" ")[0];
  const daemonOk = edge.ready && edge.mode === "daemon";
  const leaseOk = !!edge.lease && me.entitlements.features.every((f) => edge.lease!.features.includes(f));
  const connected = edge.ready && edge.link?.state === "CONNECTED";
  const onboarding = [daemonOk, leaseOk || me.entitlements.tier === "COMMUNITY", (total ?? 0) > 0];
  const allDone = onboarding.every(Boolean);

  return (
    <>
      <PageHeader
        title={name ? `G'day, ${name}` : "Welcome"}
        subtitle={`${me.workspace.name} · ${TIER_LABEL[me.entitlements.tier]} plan`}
        actions={
          <ButtonLink href="/jobs/new" variant="primary">
            Start a job
          </ButtonLink>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          {!allDone ? (
            <Card title="Get set up" subtitle="Three steps to your first diagnosis.">
              <ol className="space-y-2">
                <Step done={daemonOk} title="Connect the diagnostic daemon" href="/devices" cta="Set up">
                  {daemonOk
                    ? `Connected${edge.snapshot.hello ? ` (daemon ${edge.snapshot.hello.daemon_version})` : ""}.`
                    : "Install and run the RootCause edge daemon on the workshop computer, then pair this browser."}
                </Step>
                <Step done={leaseOk || me.entitlements.tier === "COMMUNITY"} title="Install your plan on the daemon" href="/devices#lease" cta="Install">
                  {me.entitlements.tier === "COMMUNITY"
                    ? "Community runs read-only without a lease."
                    : leaseOk
                      ? "Lease installed."
                      : "Paid features unlock on the daemon once its lease is installed."}
                </Step>
                <Step done={(total ?? 0) > 0} title="Start your first job" href="/jobs/new" cta="Start">
                  Plug the adapter into the vehicle, read the VIN and scan every module.
                </Step>
              </ol>
            </Card>
          ) : null}

          <Card title="Open jobs" actions={<Link href="/jobs" className="text-sm font-semibold text-accent underline">All jobs</Link>}>
            {error ? (
              <Banner tone="danger">{error.offline ? "You're offline; jobs will load when you're back." : error.message}</Banner>
            ) : !open ? (
              <Skeleton className="h-32" />
            ) : !open.jobs.length ? (
              <EmptyState title="No open jobs" action={<ButtonLink href="/jobs/new" size="sm">Start a job</ButtonLink>}>
                Jobs stay open until you close them out with the repair.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {open.jobs.map((j) => (
                  <li key={j.id}>
                    <Link href={`/jobs/${j.id}`} className="flex min-h-[56px] items-center justify-between gap-3 py-2 hover:text-accent">
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{j.vehicle_label ?? "Unnamed vehicle"}</span>
                        <span className="block truncate text-xs text-muted">
                          {[j.customer_ref, j.vin_redacted].filter(Boolean).join(" · ") || "No reference"} · started {relative(j.started_at)}
                        </span>
                      </span>
                      <span className="flex shrink-0 gap-1">
                        {j.dtcs.length ? <Badge tone="danger">{j.dtcs.length} code{j.dtcs.length === 1 ? "" : "s"}</Badge> : <Badge>No codes yet</Badge>}
                        {j.diagnosis ? <Badge tone="info">Diagnosed</Badge> : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Vehicle link" actions={<Link href="/devices" className="text-sm font-semibold text-accent underline">Devices</Link>}>
            {connected ? (
              <p className="text-sm">
                <Badge tone="ok">Connected</Badge> {edge.link?.adapter?.display_name ?? edge.link?.adapterId}
                <span className="block text-xs text-muted">
                  {edge.link?.safetyMode === "ACTIVE_CONFIRMED" ? "Active mode" : "Read-only (Silent)"} · since {formatDateTime(new Date(edge.link!.since).toISOString())}
                </span>
              </p>
            ) : edge.ready ? (
              <p className="text-sm text-muted">Daemon ready; no vehicle connected.</p>
            ) : (
              <p className="text-sm text-muted">{edge.mode === "browser-sim" ? "Browser demo is off." : "Daemon not connected."}</p>
            )}
          </Card>
          <Card title="This month" actions={<Link href="/workshop/billing" className="text-sm font-semibold text-accent underline">Plan</Link>}>
            <div className="space-y-3">
              <Meter label="AI diagnoses & questions" used={me.usage.ai_diagnoses_used} limit={me.entitlements.ai_diagnoses} />
              <Meter label="Schematic pages" used={me.usage.schematic_pages_used} limit={me.entitlements.schematic_pages} />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
