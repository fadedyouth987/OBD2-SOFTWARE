"use client";

import type { PidPoint } from "@/context/edge";

/** Nice min/max that always include the data and never collapse to zero span. */
export function chartRange(points: PidPoint[]): [number, number] {
  if (!points.length) return [0, 1];
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    if (p.v < lo) lo = p.v;
    if (p.v > hi) hi = p.v;
  }
  if (hi - lo < 1e-6) {
    const pad = Math.max(Math.abs(hi) * 0.1, 1);
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

export function pathFor(points: PidPoint[], t0: number, t1: number, lo: number, hi: number, w: number, h: number): string {
  if (!points.length) return "";
  const sx = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * w;
  const sy = (v: number) => h - ((v - lo) / (hi - lo)) * h;
  let d = "";
  let prevT = -Infinity;
  for (const p of points) {
    if (p.t < t0) continue;
    // Break the line over gaps (> 2 s without data) instead of inventing a slope.
    const cmd = p.t - prevT > 2000 ? "M" : "L";
    d += `${cmd}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`;
    prevT = p.t;
  }
  return d;
}

export function Sparkline({ points, now, windowMs = 30_000 }: { points: PidPoint[]; now: number; windowMs?: number }) {
  const w = 120;
  const h = 28;
  const t0 = now - windowMs;
  const visible = points.filter((p) => p.t >= t0);
  const [lo, hi] = chartRange(visible);
  const d = pathFor(visible, t0, now, lo, hi, w, h);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-7 w-full" aria-hidden>
      {d ? <path d={d} fill="none" className="stroke-accent" strokeWidth={1.5} vectorEffect="non-scaling-stroke" /> : null}
    </svg>
  );
}
