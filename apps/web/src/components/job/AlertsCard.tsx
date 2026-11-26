"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Banner, Card, EmptyState, Spinner, type Tone } from "@/components/ui";
import { useEdge } from "@/context/edge";
import { useJob } from "@/context/job";
import type { JobAlert } from "@/lib/api";

const SEV: Record<JobAlert["severity"], [Tone, string]> = {
  RED: ["danger", "Critical"],
  AMBER: ["warn", "Check"],
  INFO: ["info", "Info"],
};

function Evidence({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined);
  if (!entries.length) return null;
  return (
    <details className="mt-1 text-xs text-muted">
      <summary className="min-h-[44px] cursor-pointer py-3 leading-5">Evidence</summary>
      <pre className="mt-1 max-h-48 overflow-auto rounded bg-bg p-2 font-mono text-[11px]">{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

/**
 * Tamper audit + live heuristics pushed by the daemon. Rule 6: never a pass
 * for a check that didn't run; "not run" and "no result" are shown as such.
 */
export function AlertsCard() {
  const { job, update } = useJob();
  const edge = useEdge();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [waited, setWaited] = useState(false);
  const connected = edge.ready && edge.link?.state === "CONNECTED";
  const sameVehicle = connected && (!job?.adapter_id || job.adapter_id === edge.link?.adapterId);

  // Merge this connection's alerts into the job (by rule id) and save them.
  const merged = useMemo(() => {
    const byRule = new Map<string, JobAlert>();
    for (const a of job?.alerts ?? []) byRule.set(a.rule_id, a);
    if (sameVehicle) {
      for (const a of edge.alerts) {
        byRule.set(a.rule_id, {
          rule_id: a.rule_id,
          severity: a.severity,
          title: a.title,
          recommended_test: a.recommended_test,
          evidence_json: a.evidence_json,
        });
      }
    }
    return [...byRule.values()];
  }, [job?.alerts, edge.alerts, sameVehicle]);

  const savedKey = useRef("");
  useEffect(() => {
    if (!job || job.status !== "OPEN" || !sameVehicle || !edge.alerts.length) return;
    const key = merged.map((a) => `${a.rule_id}:${a.severity}`).sort().join("|");
    const current = (job.alerts ?? []).map((a) => `${a.rule_id}:${a.severity}`).sort().join("|");
    if (key === current || key === savedKey.current) return;
    savedKey.current = key;
    const t = setTimeout(() => {
      update({ alerts: merged })
        .then(() => setSaveError(null))
        .catch((e) => setSaveError(e instanceof Error ? e.message : "Couldn't save alerts."));
    }, 800);
    return () => clearTimeout(t);
  }, [merged, job, sameVehicle, edge.alerts.length, update]);

  useEffect(() => {
    setWaited(false);
    if (!connected) return;
    const t = setTimeout(() => setWaited(true), 15_000);
    return () => clearTimeout(t);
  }, [connected, edge.link?.since]);

  const audit = merged.filter((a) => a.rule_id.startsWith("audit."));
  const heuristics = merged.filter((a) => !a.rule_id.startsWith("audit."));
  const order = { RED: 0, AMBER: 1, INFO: 2 } as const;
  const sorted = (list: JobAlert[]) => [...list].sort((a, b) => order[a.severity] - order[b.severity]);

  const auditStatus = audit.length
    ? null
    : connected && sameVehicle
      ? waited
        ? "none"
        : "running"
      : connected
        ? "other_vehicle"
        : "not_run";

  return (
    <Card title="Tamper audit & live checks" subtitle="VIN and odometer cross-checked across modules; live fuel-trim and cold-start rules.">
      <div className="space-y-3">
        {saveError ? <Banner tone="danger">{saveError}</Banner> : null}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Cross-module audit</h3>
          {auditStatus === "running" ? (
            <div className="mt-2">
              <Spinner label="Reading VIN and odometer from each module…" />
            </div>
          ) : auditStatus === "none" ? (
            <p className="mt-2 text-sm text-muted">
              <Badge tone="info">Info</Badge> No audit result from the daemon for this connection, so nothing is verified.
            </p>
          ) : auditStatus === "other_vehicle" ? (
            <p className="mt-2 text-sm text-muted">
              <Badge>Not run</Badge> The connected adapter isn&apos;t the one this job was started on, so the audit
              isn&apos;t run for this job. Nothing is reported as passed until it runs.
            </p>
          ) : auditStatus === "not_run" ? (
            <p className="mt-2 text-sm text-muted">
              <Badge>Not run</Badge> Connect the vehicle to run the audit. Nothing is reported as passed until it runs.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {sorted(audit).map((a) => (
                <AlertRow key={a.rule_id} a={a} />
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Live checks</h3>
          {heuristics.length ? (
            <ul className="mt-2 space-y-2">
              {sorted(heuristics).map((a) => (
                <AlertRow key={a.rule_id} a={a} />
              ))}
            </ul>
          ) : (
            <EmptyState title={connected ? "Nothing flagged yet" : "No live checks recorded"}>
              {connected
                ? "The daemon watches fuel trims and cold-start behaviour while live data streams. Findings appear here."
                : "Live checks run while the vehicle is connected."}
            </EmptyState>
          )}
        </div>
      </div>
    </Card>
  );
}

function AlertRow({ a }: { a: JobAlert }) {
  const [tone, label] = SEV[a.severity];
  return (
    <li className="rounded-lg border border-line bg-raised p-2.5">
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        <Badge tone={tone}>{label}</Badge>
        {a.title}
      </p>
      {a.recommended_test ? <p className="mt-1 text-sm text-muted">Next: {a.recommended_test}</p> : null}
      <Evidence data={a.evidence_json ?? {}} />
    </li>
  );
}
