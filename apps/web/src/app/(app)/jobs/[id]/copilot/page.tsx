"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BAND_TONE } from "@/components/job/DiagnosisSummary";
import { Badge, Banner, Button, Card, EmptyState, Meter, Mono, TextArea } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { useJob } from "@/context/job";
import { api, ApiError, type AnalysisInfo, type CopilotAnswer, type DiagnosisResult } from "@/lib/api";
import { engineView, nextRunNote } from "@/lib/analysis";
import { can } from "@/lib/permissions";
import { describeDtc } from "@obd2/core/dtc-library";
import { formatDateTime, safetyTierLabel } from "@/lib/format";

interface Turn {
  q: string;
  a: CopilotAnswer;
  at: string;
}

const threadKey = (id: string) => `rootcause.copilot.${id}`;

function EngineBadge({ result }: { result: AnalysisInfo & { mode?: string } }) {
  const v = engineView(result);
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs text-muted">
      <Badge tone={v.tone}>{v.label}</Badge>
      <span>{v.detail}</span>
    </span>
  );
}

function QuotaUsedUp({ canUpgrade }: { canUpgrade: boolean }) {
  return (
    <Banner
      tone="info"
      title="This month's AI diagnoses are used up"
      action={
        canUpgrade ? (
          <Link href="/workshop/billing" className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-sm font-semibold underline">
            Upgrade
          </Link>
        ) : undefined
      }
    >
      You can still diagnose and ask: the free built-in rules answer until the quota resets on the 1st (Adelaide time).
    </Banner>
  );
}

export default function CopilotPage() {
  const { job, reload } = useJob();
  const { token, me, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<ApiError | null>(null);
  const [thread, setThread] = useState<Turn[]>([]);

  useEffect(() => {
    if (!job) return;
    try {
      const raw = sessionStorage.getItem(threadKey(job.id));
      setThread(raw ? (JSON.parse(raw) as Turn[]) : []);
    } catch {
      setThread([]);
    }
  }, [job?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!job) return null;
  const codes = [...new Set(job.dtcs.map((d) => d.code))];
  const profile = job.vehicle_profile ?? "generic_obd2_uds";
  const used = me?.usage.ai_diagnoses_used ?? 0;
  const limit = me?.entitlements.ai_diagnoses ?? 0;
  const modelConfigured = me?.ai?.model_configured ?? false;
  const outOfQuota = modelConfigured && limit > 0 && used >= limit;
  const runNote = nextRunNote({ modelConfigured, used, limit });
  const open = job.status === "OPEN";
  const d = job.diagnosis;
  const stale = d && codes.length && codes.slice().sort().join(",") !== [...d.dtcs].sort().join(",");

  const diagnose = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<DiagnosisResult>(`/api/v1/diagnose/${job.id}`, {
        token,
        body: { dtcs: codes, vehicle_profile: profile },
      });
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const ask = async () => {
    const q = question.trim();
    if (q.length < 2) return;
    setAsking(true);
    setAskError(null);
    try {
      const a = await api<CopilotAnswer>(`/api/v1/diagnose/${job.id}/ask`, {
        token,
        body: { question: q, vehicle_profile: profile, dtcs: codes },
      });
      const next = [...thread, { q, a, at: new Date().toISOString() }];
      setThread(next);
      sessionStorage.setItem(threadKey(job.id), JSON.stringify(next.slice(-30)));
      setQuestion("");
    } catch (e) {
      setAskError(e instanceof ApiError ? e : new ApiError(0, String(e)));
    } finally {
      setAsking(false);
      void refresh();
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_1fr]">
      <div className="space-y-4">
        <Card
          title="Root cause analysis"
          subtitle={d ? `Run ${formatDateTime(d.at)} on ${d.dtcs.join(", ") || "no codes"}` : "Ranks likely causes from this job's codes, the vehicle's wiring and resolved cases."}
          actions={
            open ? (
              <Button size="sm" variant="blue" busy={busy} disabled={!codes.length} onClick={() => void diagnose()}>
                {d ? "Run again" : "Diagnose"}
              </Button>
            ) : null
          }
        >
          <div className="space-y-3">
            {codes.length ? (
              <p className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="text-muted">Codes:</span>
                {codes.map((c) => (
                  <Mono key={c} className="rounded bg-raised px-1.5 py-0.5 text-xs" >
                    {c}
                  </Mono>
                ))}
              </p>
            ) : null}
            {stale ? <Banner tone="info">The codes changed since this diagnosis. Run it again to include them.</Banner> : null}
            {error ? <Banner tone="danger" title="Diagnosis failed">{error.offline ? "You're offline. Nothing was charged." : error.message}</Banner> : null}
            {outOfQuota && !error ? <QuotaUsedUp canUpgrade={can(me, "MANAGE_BILLING")} /> : null}
            {d ? <EngineBadge result={d.result} /> : null}
            {d && engineView(d.result).fallback ? <Banner tone="info">{engineView(d.result).fallback}</Banner> : null}

            {!codes.length ? (
              <EmptyState
                title="No codes to diagnose"
                action={<Link href={`/jobs/${job.id}`} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-sm font-semibold text-accent-ink underline">Scan on Overview</Link>}
              >
                Scan the vehicle first. With no stored codes, ask the Copilot about the symptoms instead.
              </EmptyState>
            ) : !d ? (
              <EmptyState title="Not diagnosed yet">{runNote}</EmptyState>
            ) : !d.result.ranked_causes.length ? (
              <p className="text-sm text-muted">No ranked causes for these codes. Matching cases and shared circuits are listed alongside.</p>
            ) : (
              <>
              {d.result.summary ? <p className="text-sm">{d.result.summary}</p> : null}
              <ol className="space-y-3">
                {d.result.ranked_causes.map((c, i) => (
                  <li key={`${c.dtc}-${i}`} className="rounded-lg border border-line bg-raised p-3">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-faint">#{i + 1}</span>
                      <Mono className="font-bold">{c.dtc}</Mono>
                      <span className="text-xs text-muted">{describeDtc(c.dtc).description}</span>
                      <Badge tone={BAND_TONE[c.confidence_band] ?? "neutral"}>{c.confidence_band} confidence</Badge>
                    </p>
                    <p className="mt-2 text-sm">{c.hypothesis}</p>
                    <p className="mt-2 text-sm">
                      <span className="font-semibold">Meter test: </span>
                      {c.multimeter_test}
                    </p>
                    {c.guided_steps.length ? (
                      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">
                        {c.guided_steps.map((s, j) => (
                          <li key={j}>
                            <span className="font-semibold text-text">{s.step}</span>: {s.action}
                            {s.safety_tier ? <Badge tone={safetyTierLabel(s.safety_tier).tone}>{safetyTierLabel(s.safety_tier).label}</Badge> : null}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {c.cited_nodes.length || c.cited_case_ids.length ? (
                      <p className="mt-2 text-xs text-faint">
                        Evidence: {[...c.cited_nodes, ...c.cited_case_ids.map((id) => `case ${id.slice(0, 8)}`)].join(" · ")}
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-faint">No matching resolved cases yet; ranked from wiring data only.</p>
                    )}
                  </li>
                ))}
              </ol>
              </>
            )}
            {d ? null : codes.length ? <p className="text-xs text-faint">{runNote}</p> : null}
          </div>
        </Card>

        <Card title="Ask the Copilot" subtitle={`About ${job.vehicle_label ?? "this vehicle"}${codes.length ? ` and ${codes.join(", ")}` : ""}. ${runNote}`}>
          <div className="space-y-3">
            {thread.length ? (
              <ul className="space-y-3">
                {thread.map((t, i) => (
                  <li key={i} className="space-y-1.5">
                    <p className="ml-auto max-w-[85%] rounded-lg bg-blue-soft px-3 py-2 text-sm">{t.q}</p>
                    <div className="max-w-[90%] rounded-lg border border-line bg-raised px-3 py-2 text-sm">
                      {!t.a.answer ? (
                        <p className="text-muted">No answer was available for this question.</p>
                      ) : (
                        <p>{t.a.answer}</p>
                      )}
                      {t.a.recommended_next_step ? (
                        <p className="mt-1.5">
                          <span className="font-semibold">Next: </span>
                          {t.a.recommended_next_step}
                        </p>
                      ) : null}
                      {t.a.cited_nodes.length ? <p className="mt-1 text-xs text-faint">Cites: {t.a.cited_nodes.join(" · ")}</p> : null}
                      <p className="mt-1.5">
                        <EngineBadge result={t.a} />
                      </p>
                      {engineView(t.a).fallback ? <p className="mt-1 text-xs text-muted">{engineView(t.a).fallback}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">e.g. &quot;I have 0 V at the injector feed, what next?&quot;</p>
            )}
            {askError ? <Banner tone="danger">{askError.offline ? "You're offline." : askError.message}</Banner> : null}
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void ask();
              }}
            >
              <TextArea
                label="Your question"
                value={question}
                maxLength={2000}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void ask();
                  }
                }}
              />
              <Button type="submit" size="sm" busy={asking} disabled={question.trim().length < 2}>
                Ask
              </Button>
            </form>
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <Card title="AI usage this month">
          {me ? (
            <Meter label="AI model answers" used={used} limit={limit} />
          ) : null}
          <p className="mt-2 text-xs text-faint">
            {modelConfigured
              ? `Only answers from the AI model (${me?.ai?.model_label ?? "configured model"}) count. Built-in rule answers are free. Resets on the 1st (Adelaide time).`
              : "No AI model is set up on this server, so the free built-in rules answer and nothing is counted."}
          </p>
        </Card>
        {d ? (
          <Card title="Shared circuits & cases">
            <div className="space-y-3 text-sm">
              {d.result.shared_circuit_nodes.length ? (
                <ul className="space-y-1">
                  {d.result.shared_circuit_nodes.map((n) => (
                    <li key={n} className="font-mono text-xs">
                      {n}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">No shared circuits on file.</p>
              )}
              <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Resolved cases</h3>
              {d.result.matched_cases.length ? (
                <ul className="space-y-2">
                  {d.result.matched_cases.map((c) => (
                    <li key={c.case_id} className="rounded border border-line p-2 text-xs">
                      <p className="font-semibold">{c.dtcs.join(", ")} · {c.engine_family}</p>
                      <p className="text-muted">{c.symptom_summary}</p>
                      <p className="mt-1">Fix: {c.verified_fix}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">No resolved cases match these codes yet. Closing out this job adds one.</p>
              )}
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
