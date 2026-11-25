"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, Banner, Button, ButtonLink, Card, Field, Mono, TextArea } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { useJob } from "@/context/job";
import { api, ApiError, type Job } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

export default function CloseoutPage() {
  const { job, setJob, cleared } = useJob();
  const { token } = useAuth();
  const [form, setForm] = useState({
    summary: "",
    actual_fix: "",
    parts: "",
    labour_notes: "",
    recommendations: "",
    dtcs_cleared: false,
    publish_case: false,
    engine_family: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!job) return;
    setForm((f) => ({
      ...f,
      dtcs_cleared: f.dtcs_cleared || cleared,
      engine_family: f.engine_family || job.vehicle_label || "",
      summary: f.summary || (job.complaint ? `Customer reported: ${job.complaint}` : ""),
    }));
  }, [job, cleared]);

  if (!job) return null;
  const reportHref = `/report/${job.id}`;

  if (job.status === "CLOSED" && job.closeout) {
    const c = job.closeout;
    return (
      <div className="space-y-4">
        <Banner tone="ok" title={`Job closed ${formatDateTime(c.closed_at)}`} action={<ButtonLink href={reportHref} size="sm">Customer report</ButtonLink>}>
          {c.case_id ? (
            <>
              Published to the resolved-case library as <Mono>{c.case_id.slice(0, 8)}</Mono> (anonymised).
            </>
          ) : (
            "Not published to the case library."
          )}
        </Banner>
        <Card title="Close-out">
          <dl className="grid gap-3 text-sm sm:grid-cols-[180px_1fr]">
            <dt className="text-muted">Findings</dt>
            <dd className="whitespace-pre-wrap">{c.summary}</dd>
            <dt className="text-muted">Repair carried out</dt>
            <dd className="whitespace-pre-wrap">{c.actual_fix}</dd>
            <dt className="text-muted">Parts replaced</dt>
            <dd>{c.parts_replaced.length ? c.parts_replaced.join(", ") : "None"}</dd>
            <dt className="text-muted">Labour notes</dt>
            <dd className="whitespace-pre-wrap">{c.labour_notes || "—"}</dd>
            <dt className="text-muted">Recommendations</dt>
            <dd className="whitespace-pre-wrap">{c.recommendations || "—"}</dd>
            <dt className="text-muted">Codes cleared</dt>
            <dd>{c.dtcs_cleared ? <Badge tone="ok">Yes</Badge> : <Badge>No</Badge>}</dd>
          </dl>
        </Card>
      </div>
    );
  }

  const codes = [...new Set(job.dtcs.map((d) => d.code))];
  const summaryErr = touched && form.summary.trim().length < 3 ? "Describe what you found (at least 3 characters)." : null;
  const fixErr = touched && form.actual_fix.trim().length < 3 ? "Describe the repair (at least 3 characters)." : null;
  const publishErr = form.publish_case && !codes.length ? "A published case needs at least one code read from the vehicle." : null;

  const submit = async () => {
    setTouched(true);
    if (form.summary.trim().length < 3 || form.actual_fix.trim().length < 3 || publishErr) return;
    setBusy(true);
    setError(null);
    try {
      const closed = await api<Job>(`/api/v1/jobs/${job.id}/close`, {
        token,
        body: {
          summary: form.summary.trim(),
          actual_fix: form.actual_fix.trim(),
          parts_replaced: form.parts
            .split(/[\n,]/)
            .map((p) => p.trim())
            .filter(Boolean)
            .slice(0, 50),
          labour_notes: form.labour_notes.trim(),
          recommendations: form.recommendations.trim(),
          dtcs_cleared: form.dtcs_cleared,
          publish_case: form.publish_case,
          engine_family: form.engine_family.trim().slice(0, 120),
        },
      });
      setJob(closed);
    } catch (e) {
      setError(e instanceof ApiError ? (e.offline ? "You're offline. Nothing was saved; try again when you're back online." : e.message) : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
      <Card title="Close out the job" subtitle="Records the repair and finishes the job. The customer report is generated from this.">
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <TextArea label="What you found" required value={form.summary} error={summaryErr} maxLength={4000} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
          <TextArea label="Repair carried out" required value={form.actual_fix} error={fixErr} maxLength={4000} onChange={(e) => setForm({ ...form, actual_fix: e.target.value })} />
          <TextArea label="Parts replaced" hint="One per line or comma-separated." value={form.parts} onChange={(e) => setForm({ ...form, parts: e.target.value })} />
          <TextArea label="Labour notes" value={form.labour_notes} maxLength={4000} onChange={(e) => setForm({ ...form, labour_notes: e.target.value })} />
          <TextArea label="Recommendations for the customer" value={form.recommendations} maxLength={4000} onChange={(e) => setForm({ ...form, recommendations: e.target.value })} />
          <label className="flex min-h-[44px] items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={form.dtcs_cleared} onChange={(e) => setForm({ ...form, dtcs_cleared: e.target.checked })} />
            <span>
              Codes were cleared after the repair
              {cleared ? <span className="block text-xs text-ok">Confirmed by the rescan in this visit.</span> : null}
            </span>
          </label>
          <fieldset className="rounded-lg border border-line p-3">
            <legend className="px-1 text-sm font-semibold">Share with other workshops</legend>
            <label className="flex min-h-[44px] items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1 h-5 w-5" checked={form.publish_case} onChange={(e) => setForm({ ...form, publish_case: e.target.checked })} />
              <span>
                Publish this fix to the resolved-case library
                <span className="block text-xs text-muted">
                  Anonymised first: the VIN is cut to make/model digits and names, plates and contact details are removed.
                </span>
              </span>
            </label>
            {form.publish_case ? (
              <Field label="Engine family" value={form.engine_family} onChange={(e) => setForm({ ...form, engine_family: e.target.value })} hint="e.g. Barra 4.0 I6" />
            ) : null}
            {publishErr ? <p className="mt-2 text-sm text-danger-ink">{publishErr}</p> : null}
          </fieldset>
          {error ? <Banner tone="danger" title="Couldn't close the job">{error}</Banner> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={busy} disabled={job.can_edit === false}>
              Close job
            </Button>
            <ButtonLink href={reportHref} variant="ghost">
              Preview report
            </ButtonLink>
          </div>
        </form>
      </Card>
      <Card title="Before you close">
        <ul className="space-y-2 text-sm">
          <li className="flex gap-2">
            {codes.length ? <Badge tone="ok">Done</Badge> : <Badge tone="warn">Missing</Badge>}
            <span>Codes recorded {codes.length ? `(${codes.join(", ")})` : <Link className="underline" href={`/jobs/${job.id}`}>scan now</Link>}</span>
          </li>
          <li className="flex gap-2">
            {job.diagnosis ? <Badge tone="ok">Done</Badge> : <Badge>Optional</Badge>}
            <span>AI diagnosis</span>
          </li>
          <li className="flex gap-2">
            {cleared ? <Badge tone="ok">Done</Badge> : <Badge>Optional</Badge>}
            <span>Codes cleared and rescanned</span>
          </li>
          <li className="flex gap-2">
            {job.odometer_km !== null ? <Badge tone="ok">Done</Badge> : <Badge>Optional</Badge>}
            <span>Odometer recorded</span>
          </li>
        </ul>
        <p className="mt-3 text-xs text-faint">A closed job can&apos;t be reopened or edited.</p>
      </Card>
    </div>
  );
}
