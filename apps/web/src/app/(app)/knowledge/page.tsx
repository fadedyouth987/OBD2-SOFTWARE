"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Banner, Button, Card, EmptyState, Field, Mono, PageHeader, Skeleton } from "@/components/ui";
import { SchematicsCard } from "@/components/files/SchematicsCard";
import { useAuth } from "@/context/auth";
import { api, ApiError, type ResolvedCase, type VehiclePlatform } from "@/lib/api";
import { describeDtc } from "@/lib/dtc-library";

const DTC_RE = /^[PCBU][0-3][0-9A-F]{3}$/;
const PAGE = 15;

export default function KnowledgePage() {
  const { token } = useAuth();
  const [query, setQuery] = useState("");
  const [caseLimit, setCaseLimit] = useState(PAGE);
  const [cases, setCases] = useState<ResolvedCase[] | null>(null);
  const [casesError, setCasesError] = useState<ApiError | null>(null);
  const [platforms, setPlatforms] = useState<VehiclePlatform[] | null>(null);
  const [platformError, setPlatformError] = useState<ApiError | null>(null);

  const code = query.trim().toUpperCase();
  const isCode = DTC_RE.test(code);

  useEffect(() => {
    setCases(null);
    setCasesError(null);
    const t = setTimeout(() => {
      api<{ cases: ResolvedCase[] }>(`/api/v1/cases${isCode ? `?dtc=${code}` : ""}`, { token })
        .then((r) => setCases(r.cases))
        .catch((e) => setCasesError(e instanceof ApiError ? e : new ApiError(0, String(e))));
    }, 250);
    return () => clearTimeout(t);
  }, [token, code, isCode]);

  useEffect(() => {
    api<{ platforms: VehiclePlatform[] }>("/api/v1/vehicles", { token })
      .then((r) => setPlatforms(r.platforms))
      .catch((e) => setPlatformError(e instanceof ApiError ? e : new ApiError(0, String(e))));
  }, [token]);

  const q = query.trim().toLowerCase();
  const shownCases = useMemo(
    () =>
      (cases ?? []).filter(
        (c) => isCode || !q || [c.symptom_summary, c.verified_fix, c.engine_family, ...c.dtcs].some((v) => v.toLowerCase().includes(q)),
      ),
    [cases, q, isCode],
  );
  const shownPlatforms = useMemo(
    () =>
      (platforms ?? []).filter(
        (p) =>
          !q ||
          (isCode
            ? Object.keys(p.common_dtcs ?? {}).includes(code)
            : [p.make, p.model, p.engine].some((v) => v.toLowerCase().includes(q))),
      ),
    [platforms, q, isCode, code],
  );
  const info = isCode ? describeDtc(code) : null;

  return (
    <>
      <PageHeader title="Knowledge" subtitle="Fault codes, fixes other workshops verified, and the vehicles with wiring data on file." />
      <div className="mb-4 max-w-xl">
        <Field label="Search codes, symptoms or vehicles" placeholder="e.g. P0171, misfire, Ranger" value={query} onChange={(e) => {
            setQuery(e.target.value);
            setCaseLimit(PAGE);
          }} />
      </div>
      {info ? (
        <Card title={code} subtitle={info.kind === "generic" ? "Generic SAE J2012 meaning" : "Manufacturer-specific code"}>
          <p className="text-sm">{info.description}</p>
        </Card>
      ) : null}
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card title="Resolved cases" subtitle="Anonymised fixes published when jobs are closed out.">
          {casesError ? (
            <Banner tone="danger">{casesError.offline ? "You're offline." : casesError.message}</Banner>
          ) : !cases ? (
            <Skeleton className="h-40" />
          ) : !shownCases.length ? (
            <EmptyState title={query ? "No matching cases" : "No cases yet"}>
              {query ? "Nobody has published a fix for that yet." : "When a job is closed out with “Publish this fix”, it appears here for every workshop."}
            </EmptyState>
          ) : (
            <>
            <ul className="space-y-2">
              {shownCases.slice(0, caseLimit).map((c) => (
                <li key={c.case_id} className="rounded-lg border border-line bg-raised p-3 text-sm">
                  <p className="flex flex-wrap items-center gap-1.5">
                    {c.dtcs.map((d) => (
                      <Mono key={d} className="rounded bg-danger-soft px-1.5 py-0.5 text-xs font-bold">
                        {d}
                      </Mono>
                    ))}
                    <span className="text-xs text-muted">{c.engine_family}</span>
                  </p>
                  <p className="mt-1.5">{c.symptom_summary}</p>
                  <p className="mt-1">
                    <span className="font-semibold">Verified fix: </span>
                    {c.verified_fix}
                  </p>
                </li>
              ))}
            </ul>
            {shownCases.length > caseLimit ? (
              <Button size="sm" className="mt-3" onClick={() => setCaseLimit((n) => n + PAGE)}>
                Show more ({shownCases.length - caseLimit} left)
              </Button>
            ) : null}
            </>
          )}
        </Card>
        <Card title="Vehicles with wiring data">
          {platformError ? (
            <Banner tone="danger">{platformError.offline ? "You're offline." : platformError.message}</Banner>
          ) : !platforms ? (
            <Skeleton className="h-40" />
          ) : !shownPlatforms.length ? (
            <EmptyState title="No matching vehicles">Generic OBD-II still works on any OBD-II compliant vehicle.</EmptyState>
          ) : (
            <ul className="space-y-2">
              {shownPlatforms.map((p) => (
                <li key={p.profile} className="rounded-lg border border-line bg-raised p-3 text-sm">
                  <p className="font-semibold">
                    {p.make} {p.model}
                  </p>
                  <p className="text-xs text-muted">{p.engine}</p>
                  <p className="mt-1 flex flex-wrap gap-1">
                    <Badge>{p.modules.length} modules</Badge>
                    <Badge>{p.shared_nodes.length} shared circuits</Badge>
                  </p>
                  {isCode && p.common_dtcs?.[code] ? <p className="mt-1 text-xs">{p.common_dtcs[code]}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <SchematicsCard platforms={platforms} className="xl:col-span-2" />
      </div>
    </>
  );
}
