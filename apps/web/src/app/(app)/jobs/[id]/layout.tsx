"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { Badge, Banner, Button, ButtonLink, EmptyState, Skeleton, cx } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { useEdge } from "@/context/edge";
import { AssignControl } from "@/components/job/AssignControl";
import { JobProvider, useJob } from "@/context/job";
import { featureAccess } from "@/lib/entitlements";
import { formatDateTime } from "@/lib/format";

function Tabs({ id }: { id: string }) {
  const path = usePathname();
  const { me } = useAuth();
  const { lease } = useEdge();
  const canLocked = featureAccess(me, lease, "CAN_RE_PRO") === "plan_locked";
  const tabs = [
    ["", "Overview"],
    ["/live", "Live data"],
    ["/modules", "Modules"],
    ["/service", "Service functions"],
    ["/copilot", "AI Copilot"],
    ["/can", canLocked ? "CAN Studio 🔒" : "CAN Studio"],
    ["/closeout", "Close out & report"],
  ];
  return (
    <nav aria-label="Job sections" className="no-print -mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-line px-1">
        {tabs.map(([suffix, label]) => {
          const href = `/jobs/${id}${suffix}`;
          const active = suffix === "" ? path === href : path.startsWith(href);
          return (
            <li key={suffix}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "inline-flex min-h-[44px] items-center border-b-2 px-3 text-sm font-semibold",
                  active ? "border-accent text-text" : "border-transparent text-muted hover:text-text",
                )}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Is the vehicle for this job connected right now? */
function LinkBar() {
  const { job } = useJob();
  const { ready, link, mode } = useEdge();
  if (!job || job.status !== "OPEN") return null;
  const connected = ready && link?.state === "CONNECTED";
  if (connected) {
    const other = job.adapter_id && link?.adapterId !== job.adapter_id;
    return other ? (
      <Banner tone="warn" title="A different adapter is connected">
        This job was started on <span className="font-mono">{job.adapter_id}</span>; you&apos;re connected to{" "}
        <span className="font-mono">{link?.adapterId}</span>. Make sure it&apos;s the same vehicle.
      </Banner>
    ) : null;
  }
  return (
    <Banner
      tone="info"
      title={ready ? "No vehicle connected" : mode === "browser-sim" ? "Browser demo isn't connected" : "Edge daemon not connected"}
      action={<ButtonLink href="/devices" size="sm">Open Devices</ButtonLink>}
    >
      You can review and edit this job. Scanning, live data and service functions need the vehicle connected.
    </Banner>
  );
}

function Header() {
  const { job } = useJob();
  if (!job) return null;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs text-muted">
          <Link href="/jobs" className="hover:underline">
            Vehicles & jobs
          </Link>{" "}
          / Job
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-extrabold tracking-tight">{job.vehicle_label || "Unnamed vehicle"}</h1>
          {job.status === "OPEN" ? <Badge tone="info">Open</Badge> : <Badge tone="ok">Closed</Badge>}
          {job.adapter_kind === "BROWSER_DEMO" ? <Badge tone="warn">Demo data</Badge> : null}
        </div>
        <p className="mt-1 text-sm text-muted">
          <span className="font-mono">{job.vin_redacted ?? "VIN not read"}</span>
          {job.odometer_km !== null ? ` · ${job.odometer_km.toLocaleString("en-AU")} km` : ""}
          {job.customer_ref ? ` · ${job.customer_ref}` : ""} · started {formatDateTime(job.started_at)}
        </p>
        <div className="no-print mt-2">
          <AssignControl />
        </div>
      </div>
      <div className="no-print flex gap-2">
        <ButtonLink href={`/report/${job.id}`} size="sm" target="_blank" rel="noopener">
          Customer report
        </ButtonLink>
      </div>
    </div>
  );
}

/** A technician looking at someone else's job: viewing is fine, changes are theirs. */
function NotYoursBar() {
  const { job } = useJob();
  if (!job || job.can_edit !== false || job.status !== "OPEN") return null;
  return (
    <Banner tone="info" title={`${job.technician_name ?? "Another technician"}'s job`}>
      You can look through it. Only they, a lead technician or the owner can change or close it.
    </Banner>
  );
}

function Body({ id, children }: { id: string; children: React.ReactNode }) {
  const { job, loading, error, reload } = useJob();
  if (error) {
    return error.status === 404 ? (
      <EmptyState title="Job not found" action={<ButtonLink href="/jobs">Back to jobs</ButtonLink>}>
        It may belong to another workshop, or the link is wrong.
      </EmptyState>
    ) : (
      <Banner tone="danger" title="Couldn't load this job" action={<Button size="sm" onClick={() => void reload()}>Retry</Button>}>
        {error.message}
      </Banner>
    );
  }
  if (loading && !job) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Header />
      <Tabs id={id} />
      <NotYoursBar />
      <LinkBar />
      {children}
    </div>
  );
}

export default function JobLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  return (
    <JobProvider id={id}>
      <Body id={id}>{children}</Body>
    </JobProvider>
  );
}
