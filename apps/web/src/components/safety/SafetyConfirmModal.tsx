"use client";

import { useRef, useState } from "react";

export interface SafetyConfirmProps {
  open: boolean;
  actionName: string;
  targetEcu: string;
  consequence: string;
  tier: "A" | "B";
  speedKmh: number;
  rpm: number;
  batteryV: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * A-DES-3 SafetyConfirmModal: names action, ECU, and consequence with a 1.5s hold-to-confirm.
 */
export function SafetyConfirmModal(props: SafetyConfirmProps) {
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  if (!props.open) return null;

  const speedOk = props.speedKmh === 0;
  const rpmOk = props.tier === "A" || props.rpm === 0;
  const battOk = props.tier === "A" || props.batteryV >= 12.5;
  const preconditionsMet = speedOk && rpmOk && battOk;

  const stopHold = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    startRef.current = null;
    setProgress(0);
  };

  const startHold = () => {
    if (!preconditionsMet) return;
    const step = (ts: number) => {
      if (!startRef.current) startRef.current = ts;
      const pct = Math.min(100, ((ts - startRef.current) / 1500) * 100);
      setProgress(pct);
      if (pct >= 100) {
        stopHold();
        props.onConfirm();
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#151a22] p-5 text-slate-100 shadow-2xl space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold">Tier {props.tier} Safety Confirmation</h2>
          <span className="font-mono text-xs text-amber-400">ECU: {props.targetEcu}</span>
        </div>
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs space-y-1">
          <div className="font-bold text-red-300">{props.actionName}</div>
          <p className="text-slate-300">{props.consequence}</p>
        </div>
        <div className="space-y-1 font-mono text-xs">
          <div>Speed == 0 km/h: {speedOk ? "PASS" : `FAIL (${props.speedKmh} km/h)`}</div>
          {props.tier === "B" ? <div>RPM == 0: {rpmOk ? "PASS" : `FAIL (${props.rpm} RPM)`}</div> : null}
          {props.tier === "B" ? <div>Battery &gt;= 12.5 V: {battOk ? "PASS" : `FAIL (${props.batteryV.toFixed(1)} V)`}</div> : null}
        </div>
        <button
          type="button"
          disabled={!preconditionsMet}
          onMouseDown={startHold}
          onMouseUp={stopHold}
          onMouseLeave={stopHold}
          onTouchStart={startHold}
          onTouchEnd={stopHold}
          className="relative h-12 w-full overflow-hidden rounded-xl border border-red-500/60 bg-slate-800 text-xs font-bold text-white disabled:opacity-40"
        >
          <div className="absolute inset-y-0 left-0 bg-[#e0242f]" style={{ width: `${progress}%` }} />
          <span className="relative z-10">
            {preconditionsMet ? "Hold 1.5s to Confirm & Mint 60s Token" : "Precondition Failed (Fail-Closed)"}
          </span>
        </button>
        <button type="button" onClick={props.onCancel} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 text-xs font-medium">
          Cancel
        </button>
      </div>
    </div>
  );
}
