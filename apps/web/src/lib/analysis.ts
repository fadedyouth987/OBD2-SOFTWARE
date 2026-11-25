import type { AnalysisInfo } from "@/lib/api";

export interface EngineView {
  /** Badge text: "AI model" or "Built-in rules". */
  label: string;
  tone: "accent" | "neutral";
  /** Longer line, e.g. "Amazon Bedrock · model · counted 4 of 50". */
  detail: string;
  /** Plain-English reason the rules ran instead of the model, if any. */
  fallback: string | null;
}

/** How to label who produced a diagnosis or answer, and whether it used quota. */
export function engineView(r: AnalysisInfo & { mode?: string }): EngineView {
  const llm = r.analysis === "llm" || r.mode === "LLM" || r.mode === "KG_RAG_SYNTHESIS";
  if (llm) {
    const counted =
      r.quota_charged && typeof r.quota_used === "number" && typeof r.quota_limit === "number"
        ? `counted ${r.quota_used} of ${r.quota_limit} this month`
        : r.quota_charged
          ? "counted against this month's quota"
          : "";
    return {
      label: "AI model",
      tone: "accent",
      detail: [r.analysis_label ?? "AI model", counted].filter(Boolean).join(" · "),
      fallback: null,
    };
  }
  return {
    label: "Built-in rules",
    tone: "neutral",
    detail: "Built-in rules · free, doesn't use AI quota",
    fallback: r.fallback_text ?? null,
  };
}

/** What pressing Diagnose / Ask will do, before it runs. */
export function nextRunNote(opts: { modelConfigured: boolean; used: number; limit: number }): string {
  if (!opts.modelConfigured) return "Runs the built-in rules. Free: doesn't use AI quota.";
  if (opts.limit > 0 && opts.used >= opts.limit)
    return "This month's AI diagnoses are used up, so the built-in rules will run. They're free.";
  if (opts.limit === 0) return "Your plan has no AI diagnoses, so the built-in rules will run. They're free.";
  return "Uses one AI diagnosis if the model answers. If it can't, the free built-in rules run and nothing is counted.";
}
