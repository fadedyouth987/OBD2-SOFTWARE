"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiError, api, type Job } from "@/lib/api";
import { useAuth } from "@/context/auth";
import { useActiveJob } from "@/context/active-job";
import type { ModuleResult } from "@/lib/scan";

interface JobValue {
  job: Job | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => Promise<void>;
  /** PATCH /jobs/{id}; returns the updated job and keeps it in context. */
  update: (fields: Record<string, unknown>) => Promise<Job>;
  setJob: (job: Job) => void;
  /** Latest scan in this browser session (module outcomes aren't stored server-side). */
  scan: { at: number; results: ModuleResult[] } | null;
  setScan: (s: { at: number; results: ModuleResult[] } | null) => void;
  /** Codes were cleared successfully in this session (pre-ticks the close-out). */
  cleared: boolean;
  setCleared: (v: boolean) => void;
}

const Ctx = createContext<JobValue | null>(null);

export function JobProvider({ id, children }: { id: string; children: React.ReactNode }) {
  const { token } = useAuth();
  const { setActive } = useActiveJob();
  const [job, setJobState] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [scan, setScan] = useState<JobValue["scan"]>(null);
  const [cleared, setCleared] = useState(false);

  const setJob = useCallback(
    (j: Job) => {
      setJobState(j);
      setActive(j);
    },
    [setActive],
  );

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const j = await api<Job>(`/api/v1/jobs/${id}`, { token });
      setJob(j);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
    } finally {
      setLoading(false);
    }
  }, [id, token, setJob]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = useCallback(
    async (fields: Record<string, unknown>) => {
      const j = await api<Job>(`/api/v1/jobs/${id}`, { method: "PATCH", body: fields, token });
      setJob(j);
      return j;
    },
    [id, token, setJob],
  );

  const value = useMemo(
    () => ({ job, loading, error, reload, update, setJob, scan, setScan, cleared, setCleared }),
    [job, loading, error, reload, update, setJob, scan, cleared],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useJob(): JobValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useJob outside JobProvider");
  return v;
}
