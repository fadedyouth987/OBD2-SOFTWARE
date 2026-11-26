"use client";

import { useCallback } from "react";
import { useNow } from "@/lib/use-now";
import { useAuth } from "@/context/auth";
import { useEdge, type DiagRequest } from "@/context/edge";
import { EdgeRequestError } from "@/lib/edge-client";
import { gatedRule } from "@/lib/edge-protocol";
import { ensureSyncSession, syncBatch, type AuditRow } from "@/lib/job-sync";
import { bytesOf, hexId, nrcText } from "@/lib/diag";
import type { Job } from "@/lib/api";
import type { DiagCommandResponse, SafetyConfirmResponse } from "@/types/edge-protocol";
import type { LiveReadings } from "@/components/safety/SafetyConfirmModal";

export interface GatedStep extends DiagRequest {
  label: string;
  module: string;
}

export interface GatedResult {
  step: GatedStep;
  ok: boolean;
  response: DiagCommandResponse | null;
  grant: SafetyConfirmResponse | null;
  message: string;
}

/** Policy tier for a request (safety_policy.json); null when not gated. */
export function tierFor(req: DiagRequest): "A" | "B" | null {
  const b = bytesOf(req.payloadHex);
  const rule = gatedRule(req.protocol, b[0], b.length > 1 ? b[1] & 0x7f : null);
  return rule ? rule.tier : null;
}

export function useLiveReadings(): LiveReadings {
  const { pids, pidSeenAt, link } = useEdge();
  const now = useNow(500);
  const age = (pid: number) => {
    const at = pidSeenAt.get(pid);
    return at === undefined ? null : Math.max(0, now - at);
  };
  const batteryPid = pids.get(0x42);
  return {
    speedKmh: pids.get(0x0d)?.value ?? null,
    rpm: pids.get(0x0c)?.value ?? null,
    batteryV: batteryPid?.value ?? link?.batteryV ?? null,
    speedAgeMs: age(0x0d),
    rpmAgeMs: age(0x0c),
    // Adapter-reported voltage arrives with AdapterStatus and has no sample time.
    batteryAgeMs: batteryPid ? age(0x42) : null,
  };
}

/**
 * Runs gated requests the only way the daemon allows: a single-use safety
 * token per request (SafetyConfirmRequest), then the request with that token.
 * Each outcome is recorded on the job's audit trail.
 */
export function useGatedRunner(job: Job | null) {
  const edge = useEdge();
  const { token } = useAuth();

  const record = useCallback(
    async (rows: AuditRow[]) => {
      if (!job || !token || !rows.length || job.status !== "OPEN") return;
      try {
        const sid = await ensureSyncSession(job, token, edge.snapshot.hello?.session_id ?? null);
        await syncBatch(token, sid, { audit: rows });
      } catch (e) {
        console.warn("couldn't record the action on the job", e);
      }
    },
    [job, token, edge.snapshot.hello],
  );

  const run = useCallback(
    async (steps: GatedStep[], ack: string): Promise<GatedResult[]> => {
      const results: GatedResult[] = [];
      const audit: AuditRow[] = [];
      for (const step of steps) {
        const tier = tierFor(step) ?? "A";
        const service = `${step.protocol} 0x${step.payloadHex.slice(0, 2)}`;
        const ecu = `${step.module} ${hexId(step.tx)}`;
        let grant: SafetyConfirmResponse | null = null;
        try {
          grant = await edge.requestSafetyToken({ ...step, ack });
          const response = await edge.diag({ ...step, safetyToken: grant.safety_token, timeoutMs: step.timeoutMs ?? 30_000 });
          const ok = response.positive;
          results.push({
            step,
            ok,
            response,
            grant,
            message: ok ? "Done." : nrcText(response.nrc?.code ?? 0x10, response.nrc?.name),
          });
          audit.push({
            seq: Date.now() * 10 + audit.length,
            at: new Date().toISOString(),
            ecu,
            service,
            tier,
            outcome: ok ? "allowed" : "response",
            nrc: response.nrc?.code,
            detail: `${step.label}: ${ok ? "positive response" : `NRC 0x${(response.nrc?.code ?? 0).toString(16)}`}`,
          });
        } catch (e) {
          const err = e instanceof EdgeRequestError ? e : null;
          const message = err ? `${err.message} ${err.hint}` : String(e);
          results.push({ step, ok: false, response: null, grant, message });
          audit.push({
            seq: Date.now() * 10 + audit.length,
            at: new Date().toISOString(),
            ecu,
            service,
            tier,
            outcome: grant ? "refused" : "token_refused",
            code: err?.code,
            detail: `${step.label}: ${err?.message ?? "failed"}`,
          });
          // A refused token means the conditions aren't met: stop the batch.
          break;
        }
      }
      void record(audit);
      return results;
    },
    [edge, record],
  );

  return { run, record };
}
