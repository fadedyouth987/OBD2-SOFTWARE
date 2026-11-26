"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Banner, Button, ButtonLink, Card, EmptyState, Field, Mono, cx } from "@/components/ui";
import { DbcCard, type LoadedDbc } from "@/components/files/DbcCard";
import { useAuth } from "@/context/auth";
import { useJob } from "@/context/job";
import { useEdge } from "@/context/edge";
import { candidateIds, classifyBits, ingest, rateHz, type BitClass, type FrameIn, type IdStats } from "@/lib/can-analysis";
import { decodeSignal, signalBits } from "@/lib/dbc";
import { hexId } from "@/lib/diag";
import { FEATURE_INFO, featureAccess } from "@/lib/entitlements";
import { formatReading } from "@/lib/format";

type Capture = "idle" | "baseline" | "action";

const BIT_STYLE: Record<BitClass, string> = {
  static: "bg-bg text-faint",
  noise: "bg-warn-soft text-warn",
  candidate: "bg-ok-soft text-ok font-bold",
  unused: "bg-transparent text-transparent",
};
const BIT_LABEL: Record<BitClass, string> = { static: "never changed", noise: "changed in baseline", candidate: "changed only during the action", unused: "beyond frame length" };

function idText(id: number, extended: boolean) {
  return extended ? `0x${id.toString(16).toUpperCase().padStart(8, "0")}` : hexId(id);
}

export default function CanStudioPage() {
  const { me } = useAuth();
  const { job } = useJob();
  const edge = useEdge();
  const access = featureAccess(me, edge.lease, "CAN_RE_PRO");
  const connected = edge.ready && edge.link?.state === "CONNECTED";

  const live = useRef<Map<number, IdStats>>(new Map());
  const baseline = useRef<Map<number, IdStats>>(new Map());
  const action = useRef<Map<number, IdStats>>(new Map());
  const [capture, setCapture] = useState<Capture>("idle");
  const captureRef = useRef<Capture>("idle");
  const [hasBaseline, setHasBaseline] = useState(false);
  const [hasAction, setHasAction] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [dbc, setDbc] = useState<LoadedDbc | null>(null);
  const totalFrames = useRef(0);
  const connectedSince = edge.link?.since ?? 0;

  useEffect(() => {
    captureRef.current = capture;
  }, [capture]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    if (!edge.client) return;
    const off = edge.client.on("CanFrameBatch", (m) => {
      if (m.type !== "CanFrameBatch" || pausedRef.current) return;
      const frames = m.frames as FrameIn[];
      const now = Date.now();
      totalFrames.current += frames.length;
      ingest(live.current, frames, now);
      if (captureRef.current === "baseline") ingest(baseline.current, frames, now);
      if (captureRef.current === "action") ingest(action.current, frames, now);
    });
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => {
      off();
      clearInterval(t);
    };
  }, [edge.client]);

  const now = Date.now();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => [...live.current.values()].sort((a, b) => a.id - b.id), [tick]);
  const q = filter.trim().toLowerCase().replace(/^0x/, "");
  const shown = q ? rows.filter((r) => r.id.toString(16).includes(q) || dbc?.dbc.messages.get(r.id)?.name.toLowerCase().includes(q)) : rows;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const candidates = useMemo(() => (hasBaseline && hasAction ? candidateIds(baseline.current, action.current) : []), [hasBaseline, hasAction, capture, tick]);
  const sel = selected !== null ? live.current.get(selected) : undefined;
  const selMsg = selected !== null ? dbc?.dbc.messages.get(selected) : undefined;

  if (access === "plan_locked") {
    return (
      <Card title="CAN Studio" subtitle={FEATURE_INFO.CAN_RE_PRO.what}>
        <div className="space-y-3 text-sm">
          <p>Watch raw CAN traffic, find which bits change when you press a switch, and decode frames with a DBC file.</p>
          <Banner tone="info" title={`Included with ${FEATURE_INFO.CAN_RE_PRO.plan} and Fleet`} action={<ButtonLink href="/workshop/billing" size="sm">See plans</ButtonLink>}>
            Your current plan doesn&apos;t include CAN Studio.
          </Banner>
        </div>
      </Card>
    );
  }

  const leaseProblem =
    access === "lease_missing" ? (
      <Banner tone="warn" title="The daemon's lease doesn't include CAN Studio yet" action={<Link className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-sm font-semibold underline" href="/devices#lease">Refresh lease</Link>}>
        The daemon only streams raw frames with a lease that includes it. Refresh the lease, then reconnect the vehicle.
      </Banner>
    ) : null;

  const startCapture = (kind: "baseline" | "action") => {
    if (kind === "baseline") {
      baseline.current = new Map();
      action.current = new Map();
      setHasBaseline(true);
      setHasAction(false);
    } else {
      action.current = new Map();
      setHasAction(true);
    }
    setCapture(kind);
  };

  return (
    <div className="space-y-4">
      {leaseProblem}
      {!connected ? <Banner tone="neutral">Connect the vehicle to stream CAN traffic.</Banner> : null}
      {connected && access === "available" && rows.length === 0 && now - connectedSince > 5000 && !paused ? (
        <Banner tone="info" title="No CAN frames yet">
          Nothing has been received on this connection. If you refreshed the lease after connecting, reconnect the vehicle so the daemon starts the raw stream. K-line vehicles don&apos;t have CAN traffic.
        </Banner>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <Card
          title="Live traffic"
          subtitle={`${rows.length} IDs · ${totalFrames.current.toLocaleString("en-AU")} frames this visit`}
          actions={
            <>
              <Button size="sm" variant="ghost" aria-pressed={paused} onClick={() => setPaused(!paused)}>
                {paused ? "Resume" : "Pause"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  live.current = new Map();
                  totalFrames.current = 0;
                  setSelected(null);
                  setTick((n) => n + 1);
                }}
              >
                Clear
              </Button>
            </>
          }
        >
          <Field label="Filter by ID or message name" hint="e.g. 3E9 or BCM_Status" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {shown.length ? (
            <div className="mt-3 max-h-[480px] overflow-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="sticky top-0 bg-panel text-xs text-muted">
                  <tr>
                    <th className="py-1.5 pr-2">ID</th>
                    <th className="py-1.5 pr-2">Name</th>
                    <th className="py-1.5 pr-2 text-right">Rate</th>
                    <th className="py-1.5">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr
                      key={r.id}
                      className={cx("cursor-pointer border-t border-line hover:bg-raised", selected === r.id && "bg-raised")}
                      onClick={() => setSelected(r.id)}
                    >
                      <td className="py-1 pr-2">
                        <button type="button" className="font-mono text-xs underline-offset-2 hover:underline" onClick={() => setSelected(r.id)} aria-pressed={selected === r.id}>
                          {idText(r.id, r.extended)}
                        </button>
                      </td>
                      <td className="py-1 pr-2 text-xs text-muted">{dbc?.dbc.messages.get(r.id)?.name ?? ""}</td>
                      <td className="py-1 pr-2 text-right font-mono text-xs tabular-nums">{rateHz(r).toFixed(1)} Hz</td>
                      <td className="py-1 font-mono text-xs">
                        {r.data.map((b, i) => (
                          <span key={i} className={cx("mr-1 rounded px-0.5", now - (r.changedAt[i] ?? 0) < 1000 && "bg-blue-soft text-text")}>
                            {b.toString(16).toUpperCase().padStart(2, "0")}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title={rows.length ? "No IDs match" : "No traffic"}>{rows.length ? "Try another filter." : "Frames appear here as they arrive."}</EmptyState>
          )}
          <p className="mt-2 text-xs text-faint">Bytes that changed in the last second are highlighted. Select an ID to see its bits.</p>
        </Card>

        <div className="space-y-4">
          <Card title="Find a signal" subtitle="Record normal traffic, then record while you operate one thing (a switch, a door, a pedal).">
            <ol className="space-y-3 text-sm">
              <li>
                <p className="font-semibold">1. Baseline</p>
                <p className="text-muted">Don&apos;t touch anything for 5–10 seconds.</p>
                <div className="mt-1 flex gap-2">
                  {capture === "baseline" ? (
                    <Button size="sm" variant="danger" onClick={() => setCapture("idle")}>
                      Stop baseline
                    </Button>
                  ) : (
                    <Button size="sm" disabled={!connected || capture !== "idle"} onClick={() => startCapture("baseline")}>
                      {hasBaseline ? "Record baseline again" : "Record baseline"}
                    </Button>
                  )}
                  {hasBaseline && capture !== "baseline" ? <Badge tone="ok">{baseline.current.size} IDs</Badge> : null}
                </div>
              </li>
              <li>
                <p className="font-semibold">2. Action</p>
                <p className="text-muted">Operate the thing a few times, then stop.</p>
                <div className="mt-1 flex gap-2">
                  {capture === "action" ? (
                    <Button size="sm" variant="danger" onClick={() => setCapture("idle")}>
                      Stop action
                    </Button>
                  ) : (
                    <Button size="sm" disabled={!connected || !hasBaseline || capture !== "idle"} onClick={() => startCapture("action")}>
                      Record action
                    </Button>
                  )}
                </div>
              </li>
            </ol>
            {hasBaseline && hasAction && capture === "idle" ? (
              candidates.length ? (
                <div className="mt-3">
                  <p className="text-sm font-semibold">Changed only during the action</p>
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {candidates.slice(0, 20).map((c) => (
                      <li key={c.id}>
                        <button type="button" onClick={() => setSelected(c.id)} className="rounded border border-ok px-2 py-1 font-mono text-xs text-ok">
                          {hexId(c.id)} · {c.bits} bit{c.bits === 1 ? "" : "s"}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted">No bits changed only during the action. Try a longer baseline, or operate the control more times.</p>
              )
            ) : null}
          </Card>

          <DbcCard loaded={dbc} onLoad={setDbc} liveIds={rows.map((r) => r.id)} vehicleProfile={job?.vehicle_profile} />
        </div>
      </div>

      {sel ? (
        <Card title={`${idText(sel.id, sel.extended)}${selMsg ? ` · ${selMsg.name}` : ""}`} subtitle={`${sel.dlc} bytes · ${rateHz(sel).toFixed(1)} Hz · ${sel.count.toLocaleString("en-AU")} frames`} actions={<Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Close</Button>}>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Bits (byte 0 at top, bit 7 left)</h3>
              <BitMatrix stats={sel} classes={hasBaseline && hasAction ? classifyBits(baseline.current.get(sel.id), action.current.get(sel.id), sel.dlc) : null} highlight={selMsg ? new Set(selMsg.signals.flatMap(signalBits)) : null} />
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Decoded signals</h3>
              {selMsg ? (
                selMsg.signals.length ? (
                  <ul className="space-y-1 text-sm">
                    {selMsg.signals.map((s) => {
                      const v = s.multiplex === "multiplexed" ? null : decodeSignal(s, sel.data);
                      return (
                        <li key={s.name} className="flex justify-between gap-2 border-b border-line py-1">
                          <span className="truncate">{s.name}</span>
                          <span className="font-mono tabular-nums">
                            {s.multiplex === "multiplexed" ? <span className="text-xs text-muted">multiplexed</span> : v === null ? "—" : `${formatReading(v)} ${s.unit}`}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">The DBC defines this message with no signals.</p>
                )
              ) : (
                <p className="text-sm text-muted">{dbc ? "This ID isn't in the loaded DBC." : "Load a DBC file to decode this ID."}</p>
              )}
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function BitMatrix({ stats, classes, highlight }: { stats: IdStats; classes: BitClass[] | null; highlight: Set<number> | null }) {
  return (
    <div>
      <table className="border-separate border-spacing-0.5 font-mono text-[11px]" aria-label="Bit matrix">
        <thead>
          <tr>
            <th className="w-8" />
            {[7, 6, 5, 4, 3, 2, 1, 0].map((b) => (
              <th key={b} className="w-7 text-center text-faint" scope="col">
                {b}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 8 }, (_, byte) => (
            <tr key={byte}>
              <th scope="row" className="pr-1 text-right text-faint">
                B{byte}
              </th>
              {[7, 6, 5, 4, 3, 2, 1, 0].map((b) => {
                const pos = byte * 8 + b;
                const value = byte < stats.data.length ? (stats.data[byte] >> b) & 1 : null;
                const cls: BitClass = byte >= stats.dlc ? "unused" : classes ? classes[pos] : (stats.toggled[byte] >> b) & 1 ? "noise" : "static";
                return (
                  <td
                    key={b}
                    title={`Byte ${byte} bit ${b}: ${value ?? "—"} (${classes ? BIT_LABEL[cls] : cls === "noise" ? "has changed" : BIT_LABEL[cls]})`}
                    className={cx("h-7 w-7 rounded text-center", BIT_STYLE[cls], highlight?.has(pos) && "ring-1 ring-blue")}
                  >
                    {value ?? ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 flex flex-wrap gap-2 text-xs text-muted">
        {classes ? (
          <>
            <span className="rounded bg-ok-soft px-1 text-ok">changed only in action</span>
            <span className="rounded bg-warn-soft px-1 text-warn">changed in baseline</span>
          </>
        ) : (
          <span className="rounded bg-warn-soft px-1 text-warn">has changed</span>
        )}
        {highlight ? <span className="rounded px-1 ring-1 ring-blue">in a DBC signal</span> : null}
        <Mono className="text-faint">{stats.data.map((x) => x.toString(16).toUpperCase().padStart(2, "0")).join(" ")}</Mono>
      </p>
    </div>
  );
}
