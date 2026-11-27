// The app's calls to the RootCause cloud API (the same /api/v1 the web app uses).

import type { ReadDtc } from "@obd2/core/diag";
import type { MeSummary } from "../plan/access";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Session {
  access_token: string;
  tenant_id: string;
  user_id?: string;
}

export interface Me extends MeSummary {
  user: { id: string; email: string | null; display_name: string | null };
  workspace: { tenant_id: string; name: string; role: string };
}

export interface Job {
  id: string;
  vehicle_label: string | null;
  status: string;
  created_at: string;
}

export interface Diagnosis {
  summary?: string;
  likely_causes?: { title: string; confidence?: string; explanation?: string }[];
  next_checks?: string[];
  [key: string]: unknown;
}

export class Api {
  constructor(
    readonly baseUrl: string,
    private token: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  setToken(token: string | null) {
    this.token = token;
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new ApiError(0, "No connection to RootCause. Check your signal and try again.");
    }
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const detail = (data as { detail?: unknown } | null)?.detail;
      const message =
        typeof detail === "string"
          ? detail
          : res.status === 401
            ? "Your sign-in has expired. Sign in again."
            : res.status === 402 || res.status === 429
              ? "You've used this month's AI diagnoses on your plan."
              : `RootCause couldn't do that (error ${res.status}).`;
      throw new ApiError(res.status, message);
    }
    return data as T;
  }

  login(email: string, password: string) {
    return this.call<Session>("/api/v1/auth/login", { body: { email, password } });
  }

  me() {
    return this.call<Me>("/api/v1/auth/me");
  }

  startJob(input: { vin?: string | null; vehicle_label?: string | null; protocol?: string | null; adapter_kind?: string }) {
    return this.call<Job>("/api/v1/jobs", { body: { adapter_kind: "STN_ELM", ...input } });
  }

  saveCodes(jobId: string, modules: { module: string; codes: ReadDtc[] }[]) {
    const dtcs = modules.flatMap((m) =>
      m.codes.map((c) => ({ code: c.code, module: m.module, status: c.status, source: "OBD" })),
    );
    return this.call<Job>(`/api/v1/jobs/${jobId}`, { method: "PATCH", body: { dtcs } });
  }

  diagnose(jobId: string, dtcs: string[]) {
    return this.call<Diagnosis>(`/api/v1/diagnose/${jobId}`, { body: { dtcs } });
  }

  report(jobId: string) {
    return this.call<Record<string, unknown>>(`/api/v1/jobs/${jobId}/report`);
  }
}
