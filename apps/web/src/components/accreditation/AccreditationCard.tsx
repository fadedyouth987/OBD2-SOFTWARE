"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Banner, Button, Card, Field, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { ApiError, api, apiBlob, type AccreditationEvidence, type AccreditationOverview } from "@/lib/api";
import { evidenceProblem, stateView, validAbn } from "@/lib/accreditation";
import { formatBytes, formatDate, formatDateTime } from "@/lib/format";

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.offline ? "You're offline. Nothing was sent." : e.message;
  return e instanceof Error ? e.message : String(e);
}

function EvidenceList({ items }: { items: AccreditationEvidence[] }) {
  const { token } = useAuth();
  const [error, setError] = useState<string | null>(null);
  if (!items.length) return null;
  return (
    <div className="text-xs">
      <p className="font-semibold text-muted">Evidence sent</p>
      <ul className="mt-1 space-y-1">
        {items.map((ev) => (
          <li key={ev.id}>
            <button
              type="button"
              className="underline"
              onClick={async () => {
                setError(null);
                const tab = window.open("", "_blank");
                try {
                  const url = URL.createObjectURL(await apiBlob(`/api/v1/accreditation/evidence/${ev.id}`, token));
                  if (tab) tab.location.href = url;
                  setTimeout(() => URL.revokeObjectURL(url), 60_000);
                } catch (e) {
                  tab?.close();
                  setError(errText(e));
                }
              }}
            >
              {ev.filename}
            </button>{" "}
            <span className="text-faint">({formatBytes(ev.size_bytes)})</span>
          </li>
        ))}
      </ul>
      {error ? <p className="mt-1 text-danger-ink">{error}</p> : null}
    </div>
  );
}

/**
 * AASRA / MVIS accreditation for the signed-in technician, or for the workshop
 * (owner only). Submissions go to a RootCause administrator for review.
 */
export function AccreditationCard({ kind, onChange, className }: { kind: "technician" | "workshop"; onChange?: () => void; className?: string }) {
  const { token, refresh } = useAuth();
  const [data, setData] = useState<AccreditationOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [member, setMember] = useState("");
  const [abn, setAbn] = useState("");
  const [police, setPolice] = useState("");
  const [licence, setLicence] = useState("");
  const [declared, setDeclared] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const d = await api<AccreditationOverview>("/api/v1/accreditation", { token });
      setData(d);
      const last = d[kind].current ?? d[kind].latest;
      if (last?.aasra_member_id) setMember((m) => m || last.aasra_member_id || "");
      if (last?.business_abn) setAbn((a) => a || last.business_abn || "");
    } catch (e) {
      setLoadError(errText(e));
    }
  }, [token, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const title = kind === "technician" ? "Your technician accreditation" : "Workshop AASRA verification";
  if (loadError) {
    return (
      <Card title={title} className={className}>
        <Banner tone="danger" title="Couldn't load accreditation" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card title={title} className={className}>
        <Skeleton className="h-32" />
      </Card>
    );
  }

  const block = data[kind];
  const view = stateView(block, kind);
  const rules = data.evidence_rules;
  const evidenceRequired = !data.dev_auto_approve;
  const fileProblem = files.length || evidenceRequired ? evidenceProblem(files, rules, evidenceRequired) : null;
  const abnOk = kind !== "workshop" || validAbn(abn);
  const datesOk = kind !== "technician" || Boolean(police || licence);
  const ready = member.trim() && abnOk && datesOk && declared && !fileProblem;
  const shown = block.pending ?? block.current ?? block.latest;
  const formOpen = view.canSubmit && (showForm || block.state === "not_submitted" || block.state === "rejected" || block.state === "expired");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const form = new FormData();
    form.append("aasra_member_id", member.trim());
    form.append("declared", String(declared));
    if (kind === "workshop") form.append("business_abn", abn.replace(/\D/g, ""));
    if (kind === "technician") {
      if (police) form.append("national_police_check_dated", police);
      if (licence) form.append("repairer_licence_renewed_at", licence);
    }
    for (const f of files) form.append("evidence", f);
    try {
      const r = await api<AccreditationOverview>(`/api/v1/accreditation/${kind}`, { form, token });
      setData(r);
      setNotice(
        r[kind].state === "approved"
          ? "Approved straight away (dev auto-approve is on for this server)."
          : "Sent for review. You'll get an email when an administrator has decided.",
      );
      setFiles([]);
      setDeclared(false);
      setShowForm(false);
      if (input.current) input.current.value = "";
      await refresh();
      onChange?.();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={title} id={kind === "workshop" ? "accreditation" : undefined} className={className} actions={<Badge tone={view.tone}>{view.badge}</Badge>}>
      <div className="space-y-3">
        <Banner tone={view.tone === "neutral" ? "info" : view.tone} title={view.title}>
          {view.body}
        </Banner>
        {notice ? <Banner tone="ok">{notice}</Banner> : null}
        {shown && block.state !== "not_submitted" ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">AASRA member</dt>
            <dd className="font-mono">{shown.aasra_member_id ?? "—"}</dd>
            {kind === "workshop" ? (
              <>
                <dt className="text-muted">ABN</dt>
                <dd className="font-mono">{shown.business_abn ?? "—"}</dd>
              </>
            ) : (
              <>
                <dt className="text-muted">Police check</dt>
                <dd>{shown.national_police_check_dated ? formatDate(shown.national_police_check_dated) : "—"}</dd>
                <dt className="text-muted">Licence renewed</dt>
                <dd>{shown.repairer_licence_renewed_at ? formatDate(shown.repairer_licence_renewed_at) : "—"}</dd>
              </>
            )}
            <dt className="text-muted">Submitted</dt>
            <dd>{formatDateTime(shown.submitted_at)}</dd>
            {block.current?.expires_at ? (
              <>
                <dt className="text-muted">Approved until</dt>
                <dd>{formatDate(block.current.expires_at)}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {shown ? <EvidenceList items={shown.evidence} /> : null}

        {view.canSubmit && !formOpen ? (
          <Button size="sm" onClick={() => setShowForm(true)}>
            Send updated paperwork
          </Button>
        ) : null}
        {formOpen ? (
          <form className="space-y-3 rounded-lg border border-line bg-raised p-3" onSubmit={submit} noValidate>
            <Field label="AASRA member ID" required value={member} maxLength={64} onChange={(e) => setMember(e.target.value)} />
            {kind === "workshop" ? (
              <Field
                label="ABN"
                required
                inputMode="numeric"
                value={abn}
                onChange={(e) => setAbn(e.target.value)}
                error={abn && !validAbn(abn) ? "That ABN isn't valid. Check the 11 digits." : null}
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="National police check date" type="date" value={police} onChange={(e) => setPolice(e.target.value)} hint="Within the last 2 years." />
                <Field label="Or repairer licence renewal date" type="date" value={licence} onChange={(e) => setLicence(e.target.value)} hint="Within the last 2 years." />
              </div>
            )}
            <div>
              <label htmlFor={`evidence-${kind}`} className="block text-xs font-semibold text-muted">
                Evidence {evidenceRequired ? "(required)" : "(optional on this dev server)"}: up to {rules.max_files} PDF, PNG or JPEG files,{" "}
                {Math.round(rules.max_bytes / 1_048_576)} MB each
              </label>
              <input
                ref={input}
                id={`evidence-${kind}`}
                type="file"
                multiple
                accept={rules.types.join(",")}
                className="mt-1 block w-full text-sm file:mr-3 file:min-h-[40px] file:rounded-lg file:border file:border-line file:bg-panel file:px-3 file:text-sm file:font-semibold file:text-text"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
              <p className="mt-1 text-xs text-faint">
                {kind === "technician"
                  ? "Your AASRA membership card and the police check or licence. Only RootCause administrators and you can open these."
                  : "The AASRA membership certificate. Only RootCause administrators and the owner can open it."}
              </p>
              {files.length && fileProblem ? <p className="mt-1 text-xs text-danger-ink">{fileProblem}</p> : null}
            </div>
            <label className="flex min-h-[44px] items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1 h-5 w-5" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
              <span>
                I declare these details are true and that security information will only be used for vehicles whose owners have
                authorised the work.
              </span>
            </label>
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" busy={busy} disabled={!ready || busy}>
                Send for review
              </Button>
              {showForm ? (
                <Button variant="ghost" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
