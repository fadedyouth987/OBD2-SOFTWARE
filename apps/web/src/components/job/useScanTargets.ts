"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/auth";
import { useEdge } from "@/context/edge";
import { api, type Job, type VehicleModule } from "@/lib/api";
import { BROWSER_SIM_ADAPTER_ID } from "@/lib/browser-sim";
import { UNSCANNABLE_VIRTUAL, scanTargets, type ScanTarget } from "@/lib/scan";

export interface ScanSetup {
  /** Simulated vehicles: their fixed module list. Real vehicles use discovery instead. */
  targets: ScanTarget[];
  unscannable: boolean;
  loading: boolean;
  /** A simulated vehicle (daemon virtual adapter or the browser demo car): scan its fixed list, no discovery. */
  virtual: boolean;
  /** Registry modules for the job's platform (null when unknown or generic). */
  modules: VehicleModule[] | null;
  /** Make family in the module catalogue; null means generic discovery. */
  family: string | null;
}

/** What to scan for this job on the connected adapter. */
export function useScanTargets(job: Job | null): ScanSetup {
  const { token } = useAuth();
  const { link } = useEdge();
  const [modules, setModules] = useState<VehicleModule[] | null>(null);
  const [family, setFamily] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const profile = job?.vehicle_profile ?? null;
  const adapterId = link?.adapterId ?? job?.adapter_id ?? null;
  const virtual = adapterId?.startsWith("virtual-") ?? false;

  useEffect(() => {
    if (!profile || virtual) {
      setModules(null);
      setFamily(null);
      return;
    }
    setLoading(true);
    api<{ modules: VehicleModule[]; family?: string | null }>(`/api/v1/vehicles/${encodeURIComponent(profile)}/services`, { token })
      .then((r) => {
        setModules(r.modules);
        setFamily(r.family ?? null);
      })
      .catch(() => {
        setModules(null);
        setFamily(null);
      })
      .finally(() => setLoading(false));
  }, [profile, virtual, token]);

  const unscannable = virtual && UNSCANNABLE_VIRTUAL.has(adapterId!.slice("virtual-".length));
  return {
    targets: unscannable ? [] : scanTargets(adapterId, modules),
    unscannable,
    loading,
    virtual: virtual || adapterId === BROWSER_SIM_ADAPTER_ID,
    modules,
    family,
  };
}
