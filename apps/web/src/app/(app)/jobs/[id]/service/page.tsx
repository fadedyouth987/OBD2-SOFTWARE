"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActiveModeNotice } from "@/components/edge/ActiveModeNotice";
import { SafetyConfirmModal } from "@/components/safety/SafetyConfirmModal";
import { tierFor, useGatedRunner, useLiveReadings, type GatedStep } from "@/components/safety/useGated";
import { Badge, Banner, Button, Card, EmptyState, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { useEdge } from "@/context/edge";
import { useJob } from "@/context/job";
import { api, ApiError, type ServiceFunction, type ServiceFunctionList } from "@/lib/api";
import { hexId, nrcText } from "@/lib/diag";
import { EdgeRequestError } from "@/lib/edge-client";
import { featureAccess } from "@/lib/entitlements";

type Phase =
  | { kind: "idle" }
  | { kind: "entering" | "starting" | "stopping" | "exiting"; fn: ServiceFunction }
  | { kind: "running"; fn: ServiceFunction; startedAt: number }
  | { kind: "done"; fn: ServiceFunction; ok: boolean; message: string };

const PHASE_TEXT = {
  entering: "Opening the extended diagnostic session…",
  starting: "Starting…",
  stopping: "Stopping…",
  exiting: "Returning the module to its default session…",
} as const;

export default function ServicePage() {
  const { job } = useJob();
  const { token, me } = useAuth();
  const edge = useEdge();
  const live = useLiveReadings();
  const { run, record } = useGatedRunner(job);
  const connected = edge.ready && edge.link?.state === "CONNECTED";
  const adapterId = edge.link?.adapterId ?? job?.adapter_id ?? null;
  const [list, setList] = useState<ServiceFunctionList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ServiceFunction | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [nowTick, setNowTick] = useState(Date.now());
  const keepAlive = useRef<ReturnType<typeof setInterval> | null>(null);

  const access = featureAccess(me, edge.lease, "UDS_ACTIVE");
  const activeMode = edge.link?.safetyMode === "ACTIVE_CONFIRMED";
  const busy = phase.kind !== "idle" && phase.kind !== "done";

  useEffect(() => {
    if (!token) return;
    setLoadError(null);
    const params = new URLSearchParams();
    if (adapterId) params.set("adapter_id", adapterId);
    if (job?.id) params.set("job_id", job.id);
    const q = params.toString();
    api<ServiceFunctionList>(`/api/v1/service-functions${q ? `?${q}` : ""}`, { token })
      .then(setList)
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : String(e)));
    // Re-match when the job's make/model/year change.
  }, [token, adapterId, job?.id, job?.vehicle_make, job?.vehicle_model, job?.model_year]);

  useEffect(() => {
    if (phase.kind !== "running") return;
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, [phase.kind]);

  const stopKeepAlive = () => {
    if (keepAlive.current) clearInterval(keepAlive.current);
    keepAlive.current = null;
  };
  useEffect(() => stopKeepAlive, []);

  const plain = useCallback(
    async (fn: ServiceFunction, hex: string) => {
      const p = fn.procedure!;
      const r = await edge.diag({ tx: p.tx_id, rx: p.rx_id, protocol: "UDS", payloadHex: hex });
      if (!r.positive) throw new Error(nrcText(r.nrc?.code ?? 0x10, r.nrc?.name));
      return r;
    },
    [edge],
  );

  const exitSession = useCallback(
    async (fn: ServiceFunction) => {
      stopKeepAlive();
      try {
        await plain(fn, fn.procedure!.exit_session_hex);
      } catch {
        /* the session times out back to default on its own */
      }
    },
    [plain],
  );

  const stepFor = (fn: ServiceFunction, hex: string, label: string): GatedStep => ({
    label,
    module: fn.procedure!.module,
    tx: fn.procedure!.tx_id,
    rx: fn.procedure!.rx_id,
    protocol: "UDS",
    payloadHex: hex,
  });

  const start = async (fn: ServiceFunction) => {
    const p = fn.procedure!;
    setConfirmError(null);
    setPhase({ kind: "entering", fn });
    try {
      await plain(fn, p.enter_session_hex);
    } catch (e) {
      const msg = e instanceof EdgeRequestError ? `${e.message} ${e.hint}` : e instanceof Error ? e.message : String(e);
      setConfirmError(`Couldn't open the extended session: ${msg}`);
      setPhase({ kind: "idle" });
      return;
    }
    // Keep the extended session alive (TesterPresent) while we work.
    keepAlive.current = setInterval(() => {
      void edge.diag({ tx: p.tx_id, rx: p.rx_id, protocol: "UDS", payloadHex: "3E00" }).catch(() => undefined);
    }, 2000);
    setPhase({ kind: "starting", fn });
    // Licensed runs record exactly which procedure version was used.
    const via = fn.source ? ` (${fn.source.name} ${fn.source.source_ref} v${fn.source.version})` : "";
    const [res] = await run([stepFor(fn, p.start_hex, `${fn.name}: start${via}`)], `${fn.name} on ${p.module}`);
    if (!res?.ok) {
      await exitSession(fn);
      setConfirmError(res?.message ?? "Not started.");
      setPhase({ kind: "idle" });
      return;
    }
    setConfirming(null);
    if (p.stop_hex) {
      setPhase({ kind: "running", fn, startedAt: Date.now() });
      return;
    }
    setPhase({ kind: "exiting", fn });
    await exitSession(fn);
    setPhase({ kind: "done", fn, ok: true, message: `${fn.name} completed: ${p.module} accepted the request.` });
  };

  const stop = async (fn: ServiceFunction) => {
    const p = fn.procedure!;
    setPhase({ kind: "stopping", fn });
    let message = `${fn.name} stopped.`;
    let ok = true;
    if (p.stop_hex && p.stop_hex !== p.exit_session_hex) {
      if (tierFor(stepFor(fn, p.stop_hex, ""))) {
        const [res] = await run([stepFor(fn, p.stop_hex, `${fn.name}: stop`)], `Stop ${fn.name} on ${p.module}`);
        if (!res?.ok) {
          ok = false;
          message = `Stop was refused (${res?.message}). Leaving the extended session instead, which ends it on most modules.`;
        }
      } else {
        try {
          await plain(fn, p.stop_hex);
        } catch (e) {
          ok = false;
          message = `Stop failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
    setPhase({ kind: "exiting", fn });
    await exitSession(fn);
    void record([
      {
        seq: Date.now() * 10,
        at: new Date().toISOString(),
        ecu: `${p.module} ${hexId(p.tx_id)}`,
        service: "UDS 0x10",
        tier: "A",
        outcome: "response",
        detail: `${fn.name}: returned to default session`,
      },
    ]);
    setPhase({ kind: "done", fn, ok, message });
  };

  if (!job) return null;
  const open = job.status === "OPEN";

  return (
    <div className="space-y-4">
      {access === "plan_locked" ? (
        <Banner tone="info" title="Service functions need Active diagnostics" action={<Link href="/workshop/billing" className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-sm font-semibold underline">See plans</Link>}>
          You can browse them on Community; running one needs Pro or higher.
        </Banner>
      ) : open && connected ? (
        <ActiveModeNotice what="Running service functions" />
      ) : null}
      {!connected && open ? <Banner tone="neutral">Connect the vehicle to run a service function.</Banner> : null}
      {!open ? <Banner tone="neutral">This job is closed.</Banner> : null}
      {list?.source === "none" ? (
        <Banner
          tone="info"
          title="No verified procedures for this vehicle"
          action={
            list.licensed_catalogue ? (
              <Link href={`/jobs/${job?.id ?? ""}`} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-sm font-semibold underline">
                Check make, model and year
              </Link>
            ) : undefined
          }
        >
          {list.note}
          {list.vehicle ? ` Looked up: ${[list.vehicle.year, list.vehicle.make, list.vehicle.model].filter(Boolean).join(" ")}.` : ""}
        </Banner>
      ) : list?.source === "simulator" ? (
        <Banner tone="info">{list.note}</Banner>
      ) : list?.source === "licensed" ? (
        <Banner tone="ok" title={`Licensed procedures for ${[list.vehicle?.year, list.vehicle?.make, list.vehicle?.model].filter(Boolean).join(" ")}`}>
          {list.note}
        </Banner>
      ) : null}

      {phase.kind !== "idle" && phase.kind !== "done" && phase.kind !== "running" && !confirming ? (
        <Banner tone="info">{PHASE_TEXT[phase.kind]}</Banner>
      ) : null}
      {phase.kind === "running" ? (
        <Card
          title={`${phase.fn.name} running`}
          subtitle={`${phase.fn.procedure!.module} · expected about ${phase.fn.procedure!.expected_seconds} s`}
          actions={
            <Button variant="danger" size="sm" onClick={() => void stop(phase.fn)}>
              Stop
            </Button>
          }
        >
          {(() => {
            const total = phase.fn.procedure!.expected_seconds;
            const elapsed = Math.round((nowTick - phase.startedAt) / 1000);
            return (
              <div>
                <div className="flex justify-between text-xs text-muted">
                  <span>Elapsed</span>
                  <span className="font-mono tabular-nums">
                    {elapsed} s / ~{total} s
                  </span>
                </div>
                <progress className="mt-1 h-2 w-full accent-[var(--accent)]" value={Math.min(elapsed, total)} max={total} aria-label="Elapsed time" />
                {elapsed > total ? <p className="mt-1 text-xs text-muted">Taking longer than expected; the module controls when it finishes.</p> : null}
              </div>
            );
          })()}
          <p className="mt-2 text-sm text-muted">Stay with the vehicle. Press Stop at any time; the module is returned to its default session.</p>
        </Card>
      ) : null}
      {phase.kind === "done" ? (
        <Banner tone={phase.ok ? "ok" : "warn"} title={phase.ok ? "Done" : "Finished with a problem"} action={<Button size="sm" variant="ghost" onClick={() => setPhase({ kind: "idle" })}>Dismiss</Button>}>
          {phase.message}
        </Banner>
      ) : null}

      {loadError ? (
        <Banner tone="danger" title="Couldn't load service functions">{loadError}</Banner>
      ) : !list ? (
        <Skeleton className="h-48" />
      ) : list.functions.length === 0 ? (
        <EmptyState title="No service functions">None are defined.</EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.functions.map((fn) => {
            const available = (fn.availability === "simulated" || fn.availability === "licensed") && !!fn.procedure;
            const canRun = open && connected && activeMode && access === "available" && available && !busy;
            return (
              <li key={fn.id} className="flex flex-col rounded-xl border border-line bg-panel p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold">{fn.name}</h3>
                  {fn.availability === "licensed" && fn.procedure ? (
                    <Badge tone="ok">Licensed</Badge>
                  ) : available ? (
                    <Badge tone="info">Simulator</Badge>
                  ) : (
                    <Badge>No verified procedure</Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted">{fn.notes}</p>
                <p className="mt-2 text-xs text-faint">
                  {fn.uds_service}
                  {fn.procedure ? ` · ${fn.procedure.module} ${hexId(fn.procedure.tx_id)} · ${fn.procedure.identifier}` : ""}
                </p>
                {fn.source ? (
                  <p className="mt-1 text-xs text-muted">
                    Source: {fn.source.name} · ref {fn.source.source_ref} v{fn.source.version}
                    {fn.source.licence_url ? (
                      <>
                        {" · "}
                        <a className="underline" href={fn.source.licence_url} target="_blank" rel="noopener noreferrer">
                          licence
                        </a>
                      </>
                    ) : (
                      ` · ${fn.source.licence}`
                    )}
                    {fn.source.notes ? <span className="block">{fn.source.notes}</span> : null}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-faint">
                  Conditions: {fn.conditions === "engine_off_battery" ? "stationary, engine off, battery ≥ 12.5 V" : "stationary"}
                </p>
                <div className="mt-auto pt-3">
                  <Button
                    size="sm"
                    variant={available ? "blue" : "ghost"}
                    disabled={!canRun}
                    onClick={() => {
                      setConfirmError(null);
                      setConfirming(fn);
                    }}
                    title={
                      !available
                        ? "No verified procedure on file for this vehicle"
                        : access !== "available"
                          ? "Needs Active diagnostics"
                          : !connected
                            ? "Connect the vehicle"
                            : !activeMode
                              ? "Reconnect in Active mode"
                              : undefined
                    }
                  >
                    {available ? "Run" : "Unavailable"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {confirming?.procedure ? (
        <SafetyConfirmModal
          open
          action={confirming.name}
          target={`${confirming.procedure.module} (${hexId(confirming.procedure.tx_id)}) · ${confirming.procedure.service} ${confirming.procedure.identifier}`}
          consequence={`${confirming.notes} Takes about ${confirming.procedure.expected_seconds} s.${confirming.procedure.stop_hex ? " You can stop it at any time." : ""}`}
          tier={tierFor(stepFor(confirming, confirming.procedure.start_hex, "")) ?? "A"}
          checklist={confirming.checklist}
          live={live}
          busy={busy}
          error={confirmError}
          confirmLabel={`Hold to start ${confirming.name.toLowerCase()}`}
          onCancel={() => {
            if (!busy) setConfirming(null);
          }}
          onConfirm={() => void start(confirming)}
        />
      ) : null}
    </div>
  );
}
