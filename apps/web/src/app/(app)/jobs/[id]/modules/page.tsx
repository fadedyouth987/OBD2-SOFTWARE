"use client";

import { useEffect, useState } from "react";
import { useScanTargets } from "@/components/job/useScanTargets";
import { Badge, Banner, Button, Card, EmptyState, Mono, Skeleton, Spinner, type Tone } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { useEdge } from "@/context/edge";
import { useJob } from "@/context/job";
import { api, type VehiclePlatform } from "@/lib/api";
import { hexId } from "@/lib/diag";
import { readIdent, type IdentResult } from "@/lib/ident";
import type { ModuleResult, ScanTarget } from "@/lib/scan";

const OUTCOME: Record<ModuleResult["outcome"], [Tone, string]> = {
  codes: ["danger", "Codes stored"],
  clear: ["ok", "No codes"],
  refused: ["warn", "Refused"],
  no_response: ["neutral", "No response"],
  error: ["danger", "Error"],
};

const keyOf = (t: ScanTarget) => `${t.module}-${t.tx}-${t.rx}`;

function busOf(t: ScanTarget, platform: VehiclePlatform | null): string {
  const reg = platform?.modules.find((m) => m.id === t.module);
  if (reg?.bus) return reg.bus;
  if (t.tx === 0x6f1) return "BMW D-CAN (extended addressing)";
  return "Diagnostic CAN (OBD port)";
}

export default function ModulesPage() {
  const { job, scan } = useJob();
  const { token } = useAuth();
  const edge = useEdge();
  const { targets, unscannable, loading } = useScanTargets(job);
  const [platform, setPlatform] = useState<VehiclePlatform | null>(null);
  const [platformState, setPlatformState] = useState<"loading" | "ok" | "none" | "error">("loading");
  const [ident, setIdent] = useState<Record<string, IdentResult | "reading">>({});
  const [readingAll, setReadingAll] = useState(false);
  const connected = edge.ready && edge.link?.state === "CONNECTED";

  useEffect(() => {
    const profile = job?.vehicle_profile;
    if (!profile) {
      setPlatformState("none");
      return;
    }
    setPlatformState("loading");
    api<{ platforms: VehiclePlatform[] }>("/api/v1/vehicles", { token })
      .then((r) => {
        const p = r.platforms.find((x) => x.profile === profile) ?? null;
        setPlatform(p);
        setPlatformState(p ? "ok" : "none");
      })
      .catch(() => setPlatformState("error"));
  }, [job?.vehicle_profile, token]);

  const readOne = async (t: ScanTarget) => {
    setIdent((s) => ({ ...s, [keyOf(t)]: "reading" }));
    const r = await readIdent((req) => edge.diag(req), t);
    setIdent((s) => ({ ...s, [keyOf(t)]: r }));
  };
  const readAll = async () => {
    setReadingAll(true);
    for (const t of targets) await readOne(t);
    setReadingAll(false);
  };

  if (!job) return null;
  const outcomes = new Map((scan?.results ?? []).map((r) => [keyOf(r.target), r]));
  const buses = new Map<string, ScanTarget[]>();
  for (const t of targets) {
    const b = busOf(t, platform);
    buses.set(b, [...(buses.get(b) ?? []), t]);
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
      <Card
        title="Modules"
        subtitle={scan ? "Scan results from this visit; identification read on demand." : "Scan from Overview to see each module's codes."}
        actions={
          <Button size="sm" variant="blue" busy={readingAll} disabled={!connected || !targets.length} onClick={() => void readAll()}>
            Read identification
          </Button>
        }
      >
        {loading ? (
          <Skeleton className="h-32" />
        ) : unscannable ? (
          <Banner tone="info">This virtual vehicle is K-line only; module access through the app isn&apos;t available yet.</Banner>
        ) : !targets.length ? (
          <EmptyState title="No modules known">Connect the vehicle to list its modules.</EmptyState>
        ) : (
          <div className="space-y-4">
            {!connected ? <Banner tone="neutral">Connect the vehicle to read identification.</Banner> : null}
            {[...buses.entries()].map(([bus, list]) => (
              <section key={bus} aria-label={bus}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">{bus}</h3>
                <ul className="space-y-2">
                  {list.map((t) => {
                    const o = outcomes.get(keyOf(t));
                    const id = ident[keyOf(t)];
                    return (
                      <li key={keyOf(t)} className="rounded-lg border border-line bg-raised p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="font-semibold">{t.module}</p>
                            <p className="font-mono text-[11px] text-faint">
                              {hexId(t.tx)} → {hexId(t.rx)} · {[t.obd ? "OBD" : null, t.protocol].filter(Boolean).join(" + ")}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            {o ? (
                              <Badge tone={OUTCOME[o.outcome][0]}>
                                {o.outcome === "codes" ? `${o.dtcs.length} code${o.dtcs.length === 1 ? "" : "s"}` : OUTCOME[o.outcome][1]}
                              </Badge>
                            ) : (
                              <Badge>Not scanned</Badge>
                            )}
                            <Button size="sm" variant="ghost" disabled={!connected || id === "reading" || readingAll} onClick={() => void readOne(t)}>
                              Identify
                            </Button>
                          </div>
                        </div>
                        {o?.dtcs.length ? (
                          <p className="mt-2 flex flex-wrap gap-1">
                            {o.dtcs.map((d) => (
                              <Mono key={d.code} className="rounded bg-danger-soft px-1.5 py-0.5 text-xs">
                                {d.code}
                              </Mono>
                            ))}
                          </p>
                        ) : null}
                        {id === "reading" ? (
                          <div className="mt-2">
                            <Spinner small label="Reading identification…" />
                          </div>
                        ) : id ? (
                          id.fields.length ? (
                            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                              {id.fields.map((f) => (
                                <div key={f.label} className="contents">
                                  <dt className="text-muted">{f.label}</dt>
                                  <dd className="font-mono">{f.value}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : (
                            <p className="mt-2 text-xs text-muted">{id.message}</p>
                          )
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      <Card title="Wiring knowledge" subtitle={platform ? `${platform.make} ${platform.model}` : undefined}>
        {platformState === "loading" ? (
          <Skeleton className="h-24" />
        ) : platformState === "error" ? (
          <Banner tone="warn">Couldn&apos;t load the vehicle registry. Check your connection.</Banner>
        ) : !platform ? (
          <EmptyState title="No platform wiring on file">
            This job uses generic OBD-II. AI diagnosis still works from the codes; shared-circuit hints need a decoded platform.
          </EmptyState>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-muted">{platform.engine}</p>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Shared circuit nodes</h3>
              {platform.shared_nodes.length ? (
                <ul className="mt-1 space-y-1">
                  {platform.shared_nodes.map((n) => (
                    <li key={n} className="font-mono text-xs">
                      {n}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted">None recorded.</p>
              )}
              <p className="mt-1 text-xs text-faint">One fault on a shared feed or ground can set codes in several modules.</p>
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Registry modules</h3>
              <ul className="mt-1 space-y-0.5 text-xs">
                {platform.modules.map((m) => (
                  <li key={m.id}>
                    <span className="font-semibold">{m.id}</span> <span className="text-muted">· {m.bus}</span>{" "}
                    <span className="font-mono text-faint">
                      {m.tx} → {m.rx}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
