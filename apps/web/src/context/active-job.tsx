"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Job } from "@/lib/api";

const KEY = "rootcause.activeJob";

export interface ActiveJobSummary {
  id: string;
  vehicle_label: string | null;
  vin_redacted: string | null;
  status: Job["status"];
}

interface ActiveJobValue {
  active: ActiveJobSummary | null;
  setActive: (job: Job | ActiveJobSummary | null) => void;
}

const Ctx = createContext<ActiveJobValue | null>(null);

export function ActiveJobProvider({ children }: { children: React.ReactNode }) {
  const [active, setState] = useState<ActiveJobSummary | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) setState(JSON.parse(raw) as ActiveJobSummary);
    } catch {
      /* ignore */
    }
  }, []);

  const setActive = useCallback((job: Job | ActiveJobSummary | null) => {
    const next = job
      ? { id: job.id, vehicle_label: job.vehicle_label, vin_redacted: job.vin_redacted, status: job.status }
      : null;
    setState(next);
    try {
      if (next) window.localStorage.setItem(KEY, JSON.stringify(next));
      else window.localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(() => ({ active, setActive }), [active, setActive]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActiveJob(): ActiveJobValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useActiveJob outside ActiveJobProvider");
  return v;
}
