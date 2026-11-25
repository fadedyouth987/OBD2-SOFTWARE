"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Banner, Button, ButtonLink, Card, EmptyState, PageHeader, Skeleton, cx } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { ApiError, api, type JobList } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

type Filter = "OPEN" | "CLOSED" | "ALL";

export default function JobsPage() {
  const { token } = useAuth();
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [data, setData] = useState<JobList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      const qs = filter === "ALL" ? "?limit=200" : `?status=${filter}&limit=200`;
      setData(await api<JobList>(`/api/v1/jobs${qs}`, { token }));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
    }
  }, [filter, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const jobs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!data) return [];
    if (!q) return data.jobs;
    return data.jobs.filter((j) =>
      [j.vehicle_label, j.vin_redacted, j.customer_ref, j.complaint, ...j.dtcs.map((d) => d.code)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [data, query]);

  return (
    <>
      <PageHeader
        title="Vehicles & jobs"
        subtitle="Every vehicle you've worked on, from first scan to customer report."
        actions={
          <ButtonLink href="/jobs/new" variant="primary">
            Start a job
          </ButtonLink>
        }
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div role="tablist" aria-label="Job status" className="flex rounded-lg border border-line p-0.5">
            {(
              [
                ["OPEN", `Open${data ? ` (${data.open})` : ""}`],
                ["CLOSED", `Closed${data ? ` (${data.closed})` : ""}`],
                ["ALL", "All"],
              ] as const
            ).map(([f, label]) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={cx(
                  "min-h-[36px] rounded-md px-3 text-xs font-semibold",
                  filter === f ? "bg-raised text-text" : "text-muted hover:text-text",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="ml-auto flex items-center gap-2 text-xs text-muted">
            <span className="sr-only">Search jobs</span>
            <input
              type="search"
              placeholder="Search vehicle, customer, code…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-h-[40px] w-64 rounded-lg border border-line bg-bg px-3 text-sm text-text placeholder:text-faint"
            />
          </label>
        </div>

        {error ? (
          <Banner tone="danger" title="Couldn't load jobs" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
            {error.message}
          </Banner>
        ) : !data ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <EmptyState
            title={query ? "No jobs match that search" : filter === "OPEN" ? "No open jobs" : "No jobs yet"}
            action={!query ? <ButtonLink href="/jobs/new" variant="primary">Start a job</ButtonLink> : null}
          >
            {query ? "Try a different word." : "Start a job when a vehicle comes in: connect, scan, diagnose, close out."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-semibold">Vehicle</th>
                  <th className="py-2 pr-3 font-semibold">Customer</th>
                  <th className="py-2 pr-3 font-semibold">Codes</th>
                  <th className="py-2 pr-3 font-semibold">Started</th>
                  <th className="py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b border-line last:border-0 hover:bg-raised">
                    <td className="py-2.5 pr-3">
                      <Link href={`/jobs/${j.id}`} className="font-semibold hover:underline">
                        {j.vehicle_label || "Unnamed vehicle"}
                      </Link>
                      <div className="font-mono text-xs text-muted">{j.vin_redacted ?? "VIN not read"}</div>
                    </td>
                    <td className="py-2.5 pr-3 text-muted">{j.customer_ref || "—"}</td>
                    <td className="py-2.5 pr-3">
                      {j.dtcs.length ? (
                        <span className="font-mono text-xs">
                          {j.dtcs.slice(0, 3).map((d) => d.code).join(", ")}
                          {j.dtcs.length > 3 ? ` +${j.dtcs.length - 3}` : ""}
                        </span>
                      ) : (
                        <span className="text-xs text-faint">none recorded</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted">{formatDateTime(j.started_at)}</td>
                    <td className="py-2.5">
                      {j.status === "OPEN" ? <Badge tone="info">Open</Badge> : <Badge tone="ok">Closed</Badge>}
                      {j.adapter_kind === "BROWSER_DEMO" ? <Badge tone="warn" className="ml-1">Demo</Badge> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
