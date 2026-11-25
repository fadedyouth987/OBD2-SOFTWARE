"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Banner, Button, Spinner } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { api, ApiError, type JobReport } from "@/lib/api";
import { APP_NAME } from "@/lib/config";
import { describeDtc } from "@/lib/dtc-library";
import { formatDateTime, formatNumber, formatReading } from "@/lib/format";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="break-inside-avoid border-t border-line pt-4">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">{title}</h2>
      {children}
    </section>
  );
}

const OUTCOME_TEXT: Record<string, string> = {
  allowed: "Completed",
  response: "Module responded",
  refused: "Refused (safety)",
  token_refused: "Not started (conditions not met)",
  token_issued: "Confirmed",
  logged: "Logged",
  bench_mode: "Bench mode",
};

export default function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const { status, token } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const [report, setReport] = useState<JobReport | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (status === "signed_out") router.replace(`/signin?next=${encodeURIComponent(path)}`);
  }, [status, router, path]);

  useEffect(() => {
    if (status !== "signed_in" || !token) return;
    api<JobReport>(`/api/v1/jobs/${id}/report`, { token })
      .then((r) => {
        setReport(r);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e : new ApiError(0, String(e))));
  }, [status, token, id]);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <Banner tone="danger" title={error.status === 404 ? "Report not found" : "Couldn't load the report"}>
          {error.status === 404 ? "This job doesn't exist in your workshop." : error.offline ? "You're offline." : error.message}
        </Banner>
        <Link href="/jobs" className="mt-4 inline-block text-sm underline">
          Back to jobs
        </Link>
      </main>
    );
  }
  if (!report) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Spinner label="Preparing the report…" />
      </main>
    );
  }

  const { job, telemetry, actions } = report;
  const c = job.closeout;
  const draft = job.status !== "CLOSED";
  const causes = job.diagnosis?.result.ranked_causes ?? [];

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6 print:max-w-none print:p-0">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <Link href={`/jobs/${job.id}${draft ? "/closeout" : ""}`} className="text-sm underline">
          ← Back to the job
        </Link>
        <Button size="sm" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>
      {draft ? (
        <Banner tone="warn" title="Draft">
          This job is still open. Close it out to finalise the report.
        </Banner>
      ) : null}

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{report.workshop.name}</h1>
          <p className="text-sm text-muted">Vehicle diagnostic report{draft ? " (draft)" : ""}</p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
          <dt className="text-muted">Job</dt>
          <dd className="font-mono">{job.id.slice(0, 8).toUpperCase()}</dd>
          {job.customer_ref ? (
            <>
              <dt className="text-muted">Reference</dt>
              <dd>{job.customer_ref}</dd>
            </>
          ) : null}
          <dt className="text-muted">Date</dt>
          <dd>{formatDateTime(job.started_at ?? report.generated_at)}</dd>
          {report.technician.display_name ? (
            <>
              <dt className="text-muted">Technician</dt>
              <dd>{report.technician.display_name}</dd>
            </>
          ) : null}
        </dl>
      </header>

      <Section title="Vehicle">
        <dl className="grid grid-cols-[140px_1fr] gap-y-1 text-sm">
          <dt className="text-muted">Vehicle</dt>
          <dd>{job.vehicle_label ?? "Not recorded"}</dd>
          <dt className="text-muted">VIN</dt>
          <dd className="font-mono">{job.vin_redacted ?? "Not read"}</dd>
          <dt className="text-muted">Odometer</dt>
          <dd>{job.odometer_km !== null ? `${formatNumber(job.odometer_km)} km` : "Not recorded"}</dd>
          {job.complaint ? (
            <>
              <dt className="text-muted">Complaint</dt>
              <dd className="whitespace-pre-wrap">{job.complaint}</dd>
            </>
          ) : null}
        </dl>
      </Section>

      <Section title="Fault codes found">
        {job.dtcs.length ? (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1 pr-2">Code</th>
                <th className="py-1 pr-2">Meaning</th>
                <th className="py-1 pr-2">Module</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {job.dtcs.map((d) => (
                <tr key={`${d.module}-${d.code}`} className="border-t border-line align-top">
                  <td className="py-1 pr-2 font-mono font-bold">{d.code}</td>
                  <td className="py-1 pr-2">{describeDtc(d.code).description}</td>
                  <td className="py-1 pr-2">{d.module}</td>
                  <td className="py-1">{d.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm">No fault codes were recorded.</p>
        )}
      </Section>

      {causes.length ? (
        <Section title="Diagnosis">
          <ul className="space-y-2 text-sm">
            {causes.slice(0, 3).map((r, i) => (
              <li key={i}>
                <span className="font-mono font-bold">{r.dtc}</span> ({r.confidence_band.toLowerCase()} confidence): {r.hypothesis}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Work carried out">
        {c ? (
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Findings</dt>
            <dd className="whitespace-pre-wrap">{c.summary}</dd>
            <dt className="text-muted">Repair</dt>
            <dd className="whitespace-pre-wrap">{c.actual_fix}</dd>
            <dt className="text-muted">Parts</dt>
            <dd>{c.parts_replaced.length ? c.parts_replaced.join(", ") : "None"}</dd>
            {c.labour_notes ? (
              <>
                <dt className="text-muted">Labour</dt>
                <dd className="whitespace-pre-wrap">{c.labour_notes}</dd>
              </>
            ) : null}
            <dt className="text-muted">Codes cleared</dt>
            <dd>{c.dtcs_cleared ? "Yes, after the repair" : "No"}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted">Not yet recorded.</p>
        )}
      </Section>

      {actions.length ? (
        <Section title="Actions performed on the vehicle">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1 pr-2">Time</th>
                <th className="py-1 pr-2">Module</th>
                <th className="py-1 pr-2">Action</th>
                <th className="py-1">Result</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.seq} className="border-t border-line align-top">
                  <td className="py-1 pr-2 whitespace-nowrap">{a.at ? formatDateTime(a.at) : "—"}</td>
                  <td className="py-1 pr-2">{a.ecu}</td>
                  <td className="py-1 pr-2">{a.detail || a.service}</td>
                  <td className="py-1">{OUTCOME_TEXT[a.outcome] ?? a.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-muted">Every action that could change the vehicle needed a safety confirmation and a stationary vehicle.</p>
        </Section>
      ) : null}

      {telemetry.pids.length ? (
        <Section title="Live data recorded">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1 pr-2">Reading</th>
                <th className="py-1 pr-2 text-right">Min</th>
                <th className="py-1 pr-2 text-right">Average</th>
                <th className="py-1 text-right">Max</th>
              </tr>
            </thead>
            <tbody>
              {telemetry.pids.map((p) => (
                <tr key={p.pid} className="border-t border-line">
                  <td className="py-1 pr-2">
                    {p.name} <span className="text-muted">({p.unit})</span>
                  </td>
                  <td className="py-1 pr-2 text-right font-mono">{formatReading(p.min)}</td>
                  <td className="py-1 pr-2 text-right font-mono">{formatReading(p.avg)}</td>
                  <td className="py-1 text-right font-mono">{formatReading(p.max)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-muted">{formatNumber(telemetry.samples)} readings.</p>
        </Section>
      ) : null}

      {c?.recommendations ? (
        <Section title="Recommendations">
          <p className="whitespace-pre-wrap text-sm">{c.recommendations}</p>
        </Section>
      ) : null}

      <footer className="border-t border-line pt-3 text-xs text-muted">
        Generated {formatDateTime(report.generated_at)} with {APP_NAME}. VINs are shown partially for privacy.
      </footer>
    </main>
  );
}
