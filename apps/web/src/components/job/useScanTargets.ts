"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/auth";
import { useEdge } from "@/context/edge";
import { api, type Job, type VehicleModule } from "@/lib/api";
import { UNSCANNABLE_VIRTUAL, scanTargets, type ScanTarget } from "@/lib/scan";

/** Modules to scan for this job on the connected adapter. */
export function useScanTargets(job: Job | null): { targets: ScanTarget[]; unscannable: boolean; loading: boolean } {
  const { token } = useAuth();
  const { link } = useEdge();
  const [modules, setModules] = useState<VehicleModule[] | null>(null);
  const [loading, setLoading] = useState(false);
  const profile = job?.vehicle_profile ?? null;
  const adapterId = link?.adapterId ?? job?.adapter_id ?? null;
  const virtual = adapterId?.startsWith("virtual-") ?? false;

  useEffect(() => {
    if (!profile || virtual) {
      setModules(null);
      return;
    }
    setLoading(true);
    api<{ modules: VehicleModule[] }>(`/api/v1/vehicles/${encodeURIComponent(profile)}/services`, { token })
      .then((r) => setModules(r.modules))
      .catch(() => setModules(null))
      .finally(() => setLoading(false));
  }, [profile, virtual, token]);

  const unscannable = virtual && UNSCANNABLE_VIRTUAL.has(adapterId!.slice("virtual-".length));
  return { targets: unscannable ? [] : scanTargets(adapterId, modules), unscannable, loading };
}
