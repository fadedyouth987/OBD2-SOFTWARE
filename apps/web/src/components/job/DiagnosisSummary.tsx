"use client";

import { Badge, ButtonLink, Card, EmptyState, type Tone } from "@/components/ui";
import { useJob } from "@/context/job";
import { formatDateTime } from "@/lib/format";

export const BAND_TONE: Record<string, Tone> = { HIGH: "ok", MEDIUM: "warn", LOW: "neutral" };

export function DiagnosisSummary() {
  const { job } = useJob();
  if (!job) return null;
  const d = job.diagnosis;
  const top = d?.result.ranked_causes?.[0];
  return (
    <Card
      title="AI root cause"
      subtitle={d ? `From ${d.dtcs.join(", ") || "no codes"} · ${formatDateTime(d.at)}` : "Ranked causes grounded in wiring data and resolved cases."}
      actions={<ButtonLink href={`/jobs/${job.id}/copilot`} size="sm">{d ? "Open Copilot" : "Diagnose"}</ButtonLink>}
    >
      {!d ? (
        <EmptyState title={job.dtcs.length ? "Not diagnosed yet" : "Scan for codes first"}>
          {job.dtcs.length ? "Run the AI diagnosis on the codes saved to this job." : "The diagnosis works from the codes read off this vehicle."}
        </EmptyState>
      ) : d.result.mode === "FALLBACK_NO_LLM" ? (
        <p className="text-sm text-muted">The AI summary wasn&apos;t available for this run; matching cases and shared circuits are in the Copilot tab.</p>
      ) : top ? (
        <div className="space-y-2 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-bold">{top.dtc}</span>
            <Badge tone={BAND_TONE[top.confidence_band] ?? "neutral"}>{top.confidence_band} confidence</Badge>
          </p>
          <p>{top.hypothesis}</p>
          {d.result.ranked_causes.length > 1 ? (
            <p className="text-xs text-muted">+{d.result.ranked_causes.length - 1} more in Copilot</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted">No ranked causes were returned.</p>
      )}
    </Card>
  );
}
