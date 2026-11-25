// Records live data and gated actions onto a job through POST /sessions/sync,
// which is idempotent on batch_id (safe to retry).

import { api, type Job } from "@/lib/api";

export function syntheticSessionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `web_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Makes sure the job has a session id to sync against; returns it. */
export async function ensureSyncSession(job: Job, token: string, preferred: string | null): Promise<string> {
  if (job.edge_session_id) return job.edge_session_id;
  const candidates = [preferred, syntheticSessionId()].filter(Boolean) as string[];
  let lastError: unknown = null;
  for (const id of candidates) {
    try {
      const updated = await api<Job>(`/api/v1/jobs/${job.id}`, {
        method: "PATCH",
        body: { edge_session_id: id },
        token,
      });
      if (updated.edge_session_id) return updated.edge_session_id;
    } catch (e) {
      lastError = e;
    }
  }
  // Another tab (or an earlier call) may have attached one already.
  try {
    const fresh = await api<Job>(`/api/v1/jobs/${job.id}`, { token });
    if (fresh.edge_session_id) return fresh.edge_session_id;
  } catch {
    /* fall through */
  }
  throw lastError ?? new Error("Couldn't attach a session to this job.");
}

export interface TelemetryRow {
  time: string;
  pid: number;
  name: string;
  value: number;
  unit: string;
}

export interface AuditRow {
  seq: number;
  at: string;
  ecu: string;
  service: string;
  tier: "A" | "B";
  outcome: "allowed" | "refused" | "response" | "token_refused";
  nrc?: number;
  code?: string;
  detail?: string;
}

export async function syncBatch(
  token: string,
  sessionId: string,
  rows: { telemetry?: TelemetryRow[]; audit?: AuditRow[] },
): Promise<void> {
  const batch = crypto.getRandomValues(new Uint32Array(2));
  await api("/api/v1/sessions/sync", {
    token,
    body: {
      batch_id: `web-${Date.now().toString(36)}-${batch[0].toString(36)}${batch[1].toString(36)}`,
      session_id: sessionId,
      watermark_us: Date.now() * 1000,
      telemetry_rows: rows.telemetry ?? [],
      audit_entries: rows.audit ?? [],
    },
  });
}
