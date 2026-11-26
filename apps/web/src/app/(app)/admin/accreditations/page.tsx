"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Banner, Button, Card, EmptyState, Field, PageHeader, Select, Skeleton, TextArea } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { ApiError, api, apiBlob, type AdminAccreditation } from "@/lib/api";
import { describeAccreditationEvent, reasonProblem } from "@/lib/admin";
import { formatBytes, formatDate, formatDateTime } from "@/lib/format";

type Status = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "REVOKED" | "SUPERSEDED" | "ALL";
const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: "PENDING", label: "Waiting for review" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "EXPIRED", label: "Expired" },
  { value: "REVOKED", label: "Revoked" },
  { value: "SUPERSEDED", label: "Replaced" },
  { value: "ALL", label: "Everything" },
];
const STATUS_TONE: Record<AdminAccreditation["status"], "info" | "ok" | "danger" | "warn" | "neutral"> = {
  PENDING: "info",
  APPROVED: "ok",
  REJECTED: "danger",
  REVOKED: "danger",
  EXPIRED: "warn",
  SUPERSEDED: "neutral",
};

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.offline ? "You're offline. Nothing changed." : e.message;
  return e instanceof Error ? e.message : String(e);
}

function Review({ item, onDone }: { item: AdminAccreditation; onDone: (msg: string) => void }) {
  const { token, me } = useAuth();
  const [expires, setExpires] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const own = Boolean(item.subject_email && item.subject_email === me?.user.email);
  const reasonErr = touched ? reasonProblem(reason) : null;

  const act = async (action: "approve" | "reject" | "revoke") => {
    if (action !== "approve") {
      setTouched(true);
      if (reasonProblem(reason)) return;
    }
    setBusy(action);
    setError(null);
    try {
      await api(`/api/v1/admin/accreditations/${item.id}/${action}`, {
        method: "POST",
        token,
        body: action === "approve" ? { expires_on: expires || null } : { reason },
      });
      onDone(
        action === "approve"
          ? `Approved ${item.subject_name ?? item.workshop ?? "the request"}. They've been emailed.`
          : action === "reject"
            ? "Rejected. The applicant has been emailed the reason."
            : "Revoked. The applicant has been emailed the reason.",
      );
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const openEvidence = async (eid: string) => {
    setError(null);
    const tab = window.open("", "_blank");
    try {
      const url = URL.createObjectURL(await apiBlob(`/api/v1/admin/accreditations/${item.id}/evidence/${eid}`, token));
      if (tab) tab.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      tab?.close();
      setError(errText(e));
    }
  };

  return (
    <Card
      title={
        <span>
          {item.kind === "TECHNICIAN" ? "Technician" : "Workshop"}: {item.kind === "TECHNICIAN" ? (item.subject_name ?? "—") : (item.workshop ?? "—")}
        </span>
      }
      subtitle={item.kind === "TECHNICIAN" ? `${item.subject_email ?? ""} · ${item.workshop ?? ""}` : `Submitted by ${item.subject_name ?? "—"}`}
      actions={<Badge tone={STATUS_TONE[item.status]}>{STATUS_OPTIONS.find((s) => s.value === item.status)?.label ?? item.status}</Badge>}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted">AASRA member</dt>
            <dd className="font-mono">{item.aasra_member_id ?? "—"}</dd>
            {item.kind === "WORKSHOP" ? (
              <>
                <dt className="text-muted">ABN</dt>
                <dd className="font-mono">{item.business_abn ?? "—"}</dd>
              </>
            ) : (
              <>
                <dt className="text-muted">Police check</dt>
                <dd>{item.national_police_check_dated ? formatDate(item.national_police_check_dated) : "—"}</dd>
                <dt className="text-muted">Licence renewed</dt>
                <dd>{item.repairer_licence_renewed_at ? formatDate(item.repairer_licence_renewed_at) : "—"}</dd>
                <dt className="text-muted">Paperwork valid to</dt>
                <dd>{item.paperwork_limit ? formatDate(item.paperwork_limit) : "—"}</dd>
              </>
            )}
            <dt className="text-muted">Submitted</dt>
            <dd>{formatDateTime(item.submitted_at)}</dd>
            {item.expires_at ? (
              <>
                <dt className="text-muted">Approved until</dt>
                <dd>{formatDate(item.expires_at)}</dd>
              </>
            ) : null}
            {item.decision_reason ? (
              <>
                <dt className="text-muted">Reason given</dt>
                <dd>{item.decision_reason}</dd>
              </>
            ) : null}
          </dl>
          <div>
            <p className="text-xs font-semibold text-muted">Evidence</p>
            {item.evidence.length ? (
              <ul className="mt-1 space-y-1">
                {item.evidence.map((ev) => (
                  <li key={ev.id}>
                    <button type="button" className="underline" onClick={() => void openEvidence(ev.id)}>
                      {ev.filename}
                    </button>{" "}
                    <span className="text-xs text-faint">
                      ({ev.content_type}, {formatBytes(ev.size_bytes)})
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-warn">No evidence attached. Don&apos;t approve without checking AASRA records another way.</p>
            )}
          </div>
          <details>
            <summary className="min-h-[44px] cursor-pointer py-3 leading-5 text-xs font-semibold text-muted">History ({item.events.length})</summary>
            <ul className="mt-1 space-y-0.5 text-xs">
              {item.events.map((ev, i) => (
                <li key={i}>
                  <span className="text-faint">{formatDateTime(ev.at)}</span> {describeAccreditationEvent(ev)}
                </li>
              ))}
            </ul>
          </details>
        </div>

        <div className="space-y-3">
          {own ? <Banner tone="warn">This is your own submission. Another admin has to review it.</Banner> : null}
          {item.status === "PENDING" ? (
            <>
              <Field
                label="Approved until (optional)"
                type="date"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
                hint={
                  item.paperwork_limit
                    ? `Leave blank for the default: two years, capped at ${formatDate(item.paperwork_limit)} when the paperwork runs out.`
                    : "Leave blank for the default: two years."
                }
              />
              <TextArea
                label="Reason (needed to reject; the applicant reads this)"
                rows={3}
                value={reason}
                maxLength={1000}
                onChange={(e) => setReason(e.target.value)}
                error={reasonErr}
              />
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" busy={busy === "approve"} disabled={Boolean(busy) || Boolean(own)} onClick={() => void act("approve")}>
                  Approve
                </Button>
                <Button variant="danger" busy={busy === "reject"} disabled={Boolean(busy) || Boolean(own)} onClick={() => void act("reject")}>
                  Reject with reason
                </Button>
              </div>
            </>
          ) : item.status === "APPROVED" ? (
            <>
              <TextArea
                label="Reason for revoking (the holder reads this)"
                rows={3}
                value={reason}
                maxLength={1000}
                onChange={(e) => setReason(e.target.value)}
                error={reasonErr}
              />
              <Button variant="danger" busy={busy === "revoke"} disabled={Boolean(busy) || Boolean(own)} onClick={() => void act("revoke")}>
                Revoke
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted">Nothing to decide. This request is closed.</p>
          )}
          {error ? <Banner tone="danger">{error}</Banner> : null}
        </div>
      </div>
    </Card>
  );
}

export default function AdminAccreditationsPage() {
  const { token } = useAuth();
  const [status, setStatus] = useState<Status>("PENDING");
  const [items, setItems] = useState<AdminAccreditation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reminding, setReminding] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ items: AdminAccreditation[] }>(`/api/v1/admin/accreditations?status=${status}`, { token });
      setItems(r.items);
    } catch (e) {
      setError(errText(e));
    }
  }, [token, status]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Accreditation review"
        subtitle="Check AASRA / MVIS details and evidence before anyone can do security work."
        actions={
          <Button
            busy={reminding}
            onClick={async () => {
              setReminding(true);
              setNotice(null);
              setError(null);
              try {
                const r = await api<{ reminded: number; expired: number; emails_sent: number }>("/api/v1/admin/accreditations/run-reminders", {
                  method: "POST",
                  token,
                });
                setNotice(`Reminders: ${r.reminded} due, ${r.emails_sent} email${r.emails_sent === 1 ? "" : "s"} sent, ${r.expired} expired.`);
                await load();
              } catch (e) {
                setError(errText(e));
              } finally {
                setReminding(false);
              }
            }}
          >
            Run expiry reminders now
          </Button>
        }
      />
      <div className="space-y-4">
        <Select
          label="Show"
          className="max-w-xs"
          value={status}
          onChange={(e) => setStatus(e.target.value as Status)}
          options={STATUS_OPTIONS}
        />
        {notice ? <Banner tone="ok">{notice}</Banner> : null}
        {error ? (
          <Banner tone="danger" title="Couldn't load the queue" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
            {error}
          </Banner>
        ) : null}
        {items === null && !error ? <Skeleton className="h-64" /> : null}
        {items && items.length === 0 ? (
          <EmptyState title={status === "PENDING" ? "Nothing waiting for review" : "Nothing here"}>
            {status === "PENDING" ? "New submissions appear here, oldest first." : "Try another filter."}
          </EmptyState>
        ) : null}
        {items?.map((item) => (
          <Review
            key={item.id}
            item={item}
            onDone={(msg) => {
              setNotice(msg);
              void load();
            }}
          />
        ))}
      </div>
    </>
  );
}
