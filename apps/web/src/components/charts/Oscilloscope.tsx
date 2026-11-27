"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PidPoint } from "@/context/edge";
import { formatReading } from "@/lib/format";
import { chartRange } from "@/components/charts/LineChart";

export interface ScopeChannel {
  pid: number;
  name: string;
  unit: string;
  points: PidPoint[];
}

const LANE_H = 64;
/** A gap longer than this breaks the trace instead of inventing a slope. */
const GAP_MS = 2000;

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/**
 * Task 4.1 live oscilloscope: one Canvas 2D surface, one lane per PID with its
 * own scale (RPM, g/s, % and °C don't share an axis), redrawn on each tick.
 * The DOM column beside it carries the names and current values, so the
 * readings stay readable by screen readers and in Playwright.
 */
export function Oscilloscope({ channels, windowMs, now }: { channels: ScopeChannel[]; windowMs: number; now: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const titleId = useId();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !width) return;
    const dpr = window.devicePixelRatio || 1;
    const h = channels.length * LANE_H;
    if (c.width !== Math.round(width * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const frame = requestAnimationFrame(() => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, h);
      const line = cssVar(c, "--line", "#2a3342");
      const trace = cssVar(c, "--blue-ink", "#7ab0ff");
      const t0 = now - windowMs;
      const sx = (t: number) => ((t - t0) / Math.max(1, windowMs)) * width;
      ctx.lineWidth = 1;
      ctx.strokeStyle = line;
      for (let s = 1; s < 6; s++) {
        const x = Math.round((s / 6) * width) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      channels.forEach((ch, i) => {
        const top = i * LANE_H;
        ctx.strokeStyle = line;
        ctx.beginPath();
        ctx.moveTo(0, top + LANE_H - 0.5);
        ctx.lineTo(width, top + LANE_H - 0.5);
        ctx.stroke();
        const visible = ch.points.filter((p) => p.t >= t0);
        if (!visible.length) return;
        const [lo, hi] = chartRange(visible);
        const pad = 6;
        const sy = (v: number) => top + pad + (1 - (v - lo) / (hi - lo)) * (LANE_H - 2 * pad);
        ctx.strokeStyle = trace;
        ctx.lineWidth = 1.75;
        ctx.lineJoin = "round";
        ctx.beginPath();
        let prev = -Infinity;
        for (const p of visible) {
          const x = sx(p.t);
          const y = sy(p.v);
          if (p.t - prev > GAP_MS) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          prev = p.t;
        }
        ctx.stroke();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [channels, windowMs, now, width]);

  const summary = `Oscilloscope, last ${Math.round(windowMs / 1000)} seconds: ${channels
    .map((ch) => {
      const last = ch.points.at(-1);
      return `${ch.name} ${last ? `${formatReading(last.v)} ${ch.unit}` : "no reading"}`;
    })
    .join("; ")}.`;

  return (
    <figure data-testid="scope" className="rounded-lg border border-line bg-raised p-3">
      <figcaption id={titleId} className="sr-only">
        {summary}
      </figcaption>
      <div className="flex gap-3">
        <ul className="w-44 shrink-0 sm:w-52" aria-hidden>
          {channels.map((ch) => {
            const last = ch.points.at(-1);
            return (
              <li key={ch.pid} className="flex flex-col justify-center border-b border-line last:border-0" style={{ height: LANE_H }}>
                <span className="truncate text-xs text-muted">{ch.name}</span>
                <span className="font-mono text-base font-bold tabular-nums">
                  {last ? formatReading(last.v) : "—"} <span className="text-xs font-normal text-muted">{ch.unit}</span>
                </span>
              </li>
            );
          })}
        </ul>
        <div ref={box} className="min-w-0 flex-1">
          <canvas
            ref={canvas}
            role="img"
            aria-labelledby={titleId}
            className="block w-full"
            style={{ height: channels.length * LANE_H }}
          />
        </div>
      </div>
      <div className="mt-1 flex justify-end font-mono text-[11px] text-faint">−{Math.round(windowMs / 1000)} s → now</div>
    </figure>
  );
}
