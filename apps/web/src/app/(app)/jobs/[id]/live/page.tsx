"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LineChart, Sparkline } from "@/components/charts/LineChart";
import { Badge, Banner, Button, Card, EmptyState, Select, Spinner } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { PID_WINDOW_MS, useEdge, type PidSeries } from "@/context/edge";
import { useJob } from "@/context/job";
import { formatNumber, formatReading } from "@/lib/format";
import { ensureSyncSession, syncBatch, type TelemetryRow } from "@/lib/job-sync";

const DEFAULT_CHARTS = [0x0c, 0x0d, 0x05, 0x06];
const WINDOWS = [
  { ms: 30_000, label: "30 s" },
  { ms: 60_000, label: "1 min" },
  { ms: 120_000, label: "2 min" },
];
const FLUSH_MS = 5_000;

function pidLabel(pid: number) {
  return `0x${pid.toString(16).toUpperCase().padStart(2, "0")}`;
}

export default function LivePage() {
  const { job, reload } = useJob();
  const { token } = useAuth();
  const edge = useEdge();
  const connected = edge.ready && edge.link?.state === "CONNECTED";
  const [charts, setCharts] = useState<number[]>(DEFAULT_CHARTS);
  const [windowMs, setWindowMs] = useState(60_000);
  const [paused, setPaused] = useState<number | null>(null);

  // Recording to the job: one sample per PID per second, flushed every 5 s.
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);
  const buffer = useRef<TelemetryRow[]>([]);
  const lastKept = useRef<Map<number, number>>(new Map());
  const sessionId = useRef<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const series: PidSeries[] = useMemo(() => [...(edge.pidHistory.current?.values() ?? [])].sort((a, b) => a.pid - b.pid), [edge.pidTick, edge.pidHistory]);
  const now = paused ?? Date.now();

  useEffect(() => {
    if (!recording) return;
    for (const [pid, s] of edge.pids) {
      const t = Math.floor(s.timestamp_us / 1000);
      const prev = lastKept.current.get(pid) ?? 0;
      if (t - prev < 1000) continue;
      lastKept.current.set(pid, t);
      buffer.current.push({ time: new Date(t).toISOString(), pid, name: s.name, value: s.value, unit: s.unit });
    }
  }, [edge.pids, recording]);

  const flush = useCallback(async () => {
    if (!job || !token || !buffer.current.length) return;
    const rows = buffer.current.splice(0, buffer.current.length);
    try {
      if (!sessionId.current) sessionId.current = await ensureSyncSession(job, token, edge.snapshot.hello?.session_id ?? null);
      await syncBatch(token, sessionId.current, { telemetry: rows });
      setRecorded((n) => n + rows.length);
      setRecordError(null);
    } catch (e) {
      // Keep the rows for the next attempt (bounded to ~10 minutes of data).
      buffer.current.unshift(...rows.slice(-6000));
      setRecordError(e instanceof Error ? e.message : "Couldn't save live data.");
    }
  }, [job, token, edge.snapshot.hello]);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => void flush(), FLUSH_MS);
    return () => clearInterval(t);
  }, [recording, flush]);

  useEffect(() => {
    if (recording && !connected) {
      setRecording(false);
      void flush();
    }
  }, [recording, connected, flush]);

  const stop = async () => {
    setRecording(false);
    await flush();
    void reload();
  };

  if (!job) return null;
  const open = job.status === "OPEN";

  if (!connected) {
    return (
      <EmptyState title="No live data" action={<Link href="/devices" className="text-sm font-semibold text-accent-ink underline">Connect a device</Link>}>
        Live data streams while a vehicle is connected. {edge.ready ? "Choose an adapter on Devices." : "The diagnostic daemon isn't connected."}
      </EmptyState>
    );
  }

  const bySeries = new Map(series.map((s) => [s.pid, s]));
  const chartSeries = charts.map((pid) => bySeries.get(pid)).filter(Boolean) as PidSeries[];

  return (
    <div className="space-y-4">
      <Card
        title="Live data"
        subtitle={`${series.length} PID${series.length === 1 ? "" : "s"} streaming from ${edge.link?.adapter?.display_name ?? edge.link?.adapterId}`}
        actions={
          <>
            <Select
              label="Window"
              hideLabel
              value={String(windowMs)}
              onChange={(e) => setWindowMs(Number(e.target.value))}
              options={WINDOWS.map((w) => ({ value: String(w.ms), label: w.label }))}
            />
            <Button size="sm" variant="ghost" onClick={() => setPaused(paused ? null : Date.now())} aria-pressed={!!paused}>
              {paused ? "Resume" : "Pause"}
            </Button>
            {open ? (
              recording ? (
                <Button size="sm" variant="danger" onClick={() => void stop()}>
                  Stop recording
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="blue"
                  onClick={() => {
                    lastKept.current = new Map();
                    setRecordError(null);
                    setRecording(true);
                  }}
                >
                  Record to job
                </Button>
              )
            ) : null}
          </>
        }
      >
        <div className="space-y-3">
          {recording ? (
            <Banner tone="info" title="Recording">
              Saving one reading per PID per second to this job · {formatNumber(recorded)} saved
              {buffer.current.length ? `, ${buffer.current.length} waiting` : ""}.
            </Banner>
          ) : recorded ? (
            <Banner tone="ok">{formatNumber(recorded)} readings saved to this job. They appear in the report.</Banner>
          ) : null}
          {recordError ? <Banner tone="warn" title="Recording paused on an error; retrying">{recordError}</Banner> : null}
          {paused ? <Banner tone="neutral">Charts paused. Data is still being collected.</Banner> : null}
          {!series.length ? (
            <Spinner label="Waiting for the first readings…" />
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {series.map((s) => {
                const last = s.points.at(-1);
                const charted = charts.includes(s.pid);
                return (
                  <li key={s.pid}>
                    <button
                      type="button"
                      aria-pressed={charted}
                      onClick={() =>
                        setCharts((c) => (charted ? c.filter((p) => p !== s.pid) : [...c, s.pid].slice(-6)))
                      }
                      className={`w-full rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                        charted ? "border-accent bg-raised" : "border-line bg-raised hover:border-faint"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-1 text-xs text-muted">
                        <span className="truncate">{s.name}</span>
                        <span className="font-mono text-[10px] text-faint">{pidLabel(s.pid)}</span>
                      </span>
                      <span className="mt-0.5 block font-mono text-xl font-bold tabular-nums">
                        {last ? formatReading(last.v) : "—"} <span className="text-xs font-normal text-muted">{s.unit}</span>
                      </span>
                      <Sparkline points={s.points} now={now} />
                      <span className="sr-only">{charted ? "Charted. Press to remove from charts." : "Press to chart."}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-faint">
            Tap a reading to add or remove its chart (up to 6). The last {PID_WINDOW_MS / 60_000} minutes are kept in this browser.
          </p>
        </div>
      </Card>

      {chartSeries.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {chartSeries.map((s) => (
            <LineChart key={s.pid} title={s.name} unit={s.unit} points={s.points} windowMs={windowMs} now={now} />
          ))}
        </div>
      ) : series.length ? (
        <EmptyState title="No charts selected">Tap a reading above to chart it.</EmptyState>
      ) : null}
      {charts.some((pid) => !bySeries.has(pid)) && series.length ? (
        <p className="text-xs text-muted">
          <Badge>Not supported</Badge> {charts.filter((p) => !bySeries.has(p)).map(pidLabel).join(", ")} isn&apos;t reported by this vehicle.
        </p>
      ) : null}
    </div>
  );
}
