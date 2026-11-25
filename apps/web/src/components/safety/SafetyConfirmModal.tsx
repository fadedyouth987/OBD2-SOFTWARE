"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge, Banner, Button, cx } from "@/components/ui";
import { SAFETY_POLICY } from "@/lib/edge-protocol";

const HOLD_MS = 1500;

export interface LiveReadings {
  speedKmh: number | null;
  rpm: number | null;
  batteryV: number | null;
}

export interface SafetyConfirmProps {
  open: boolean;
  /** What will happen, e.g. "Clear diagnostic trouble codes". */
  action: string;
  /** Which module(s), e.g. "PCM (0x7E0)". */
  target: string;
  /** What it changes on the vehicle. */
  consequence: string;
  /** Tier from safety_policy.json for this request; the daemon enforces it. */
  tier: "A" | "B";
  /** Extra workshop conditions the technician ticks off. */
  checklist?: string[];
  live: LiveReadings;
  busy?: boolean;
  error?: string | null;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

type Check = { label: string; state: "ok" | "fail" | "unknown"; value: string };

function liveChecks(tier: "A" | "B", live: LiveReadings): Check[] {
  const req = SAFETY_POLICY.tiers[tier];
  const checks: Check[] = [
    {
      label: `Vehicle stationary (${req.max_speed_kmh} km/h)`,
      state: live.speedKmh === null ? "unknown" : live.speedKmh <= req.max_speed_kmh ? "ok" : "fail",
      value: live.speedKmh === null ? "no reading" : `${live.speedKmh.toFixed(0)} km/h`,
    },
  ];
  if (req.max_rpm !== null) {
    checks.push({
      label: "Engine off (0 rpm)",
      state: live.rpm === null ? "unknown" : live.rpm <= req.max_rpm ? "ok" : "fail",
      value: live.rpm === null ? "no reading" : `${live.rpm.toFixed(0)} rpm`,
    });
  }
  if (req.min_battery_v !== null) {
    checks.push({
      label: `Battery at least ${req.min_battery_v} V`,
      state: live.batteryV === null ? "unknown" : live.batteryV >= req.min_battery_v ? "ok" : "fail",
      value: live.batteryV === null ? "no reading" : `${live.batteryV.toFixed(1)} V`,
    });
  }
  return checks;
}

/**
 * A-DES-3 / A-DES-6: names action, module and consequence; shows the policy
 * tier the daemon will enforce with live readings; 1.5 s hold to confirm with
 * pointer OR keyboard (hold Space/Enter); focus trapped; Escape cancels.
 */
export function SafetyConfirmModal(props: SafetyConfirmProps) {
  const { open, busy, onCancel } = props;
  const titleId = useId();
  const descId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const holdBtn = useRef<HTMLButtonElement>(null);
  const [ticked, setTicked] = useState<boolean[]>([]);
  const [progress, setProgress] = useState(0);
  const raf = useRef<number | null>(null);
  const started = useRef<number | null>(null);
  const opener = useRef<Element | null>(null);

  const checklist = props.checklist ?? [];
  const checks = liveChecks(props.tier, props.live);
  const liveFail = checks.some((c) => c.state === "fail");
  const allTicked = checklist.every((_, i) => ticked[i]);
  const canHold = allTicked && !liveFail && !busy;

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    setTicked(checklist.map(() => false));
    setProgress(0);
    const first = dialog.current?.querySelector<HTMLElement>("input,button");
    first?.focus();
    return () => {
      (opener.current as HTMLElement | null)?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stopHold = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    started.current = null;
    setProgress(0);
  }, []);

  const startHold = useCallback(() => {
    if (!canHold || raf.current) return;
    const step = (ts: number) => {
      if (started.current === null) started.current = ts;
      const pct = Math.min(100, ((ts - started.current) / HOLD_MS) * 100);
      setProgress(pct);
      if (pct >= 100) {
        raf.current = null;
        started.current = null;
        setProgress(0);
        props.onConfirm();
        return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, [canHold, props]);

  useEffect(() => stopHold, [stopHold]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        stopHold();
        onCancel();
      }
      if (e.key === "Tab" && dialog.current) {
        const items = [...dialog.current.querySelectorAll<HTMLElement>("input,button,a,[tabindex]")].filter(
          (el) => !el.hasAttribute("disabled"),
        );
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel, stopHold]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-xl border border-line bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-extrabold">
            {props.action}
          </h2>
          <Badge tone={props.tier === "B" ? "danger" : "warn"}>Safety tier {props.tier}</Badge>
        </div>
        <dl id={descId} className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-xs font-semibold text-muted">Module</dt>
            <dd className="font-mono">{props.target}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-muted">What it does</dt>
            <dd>{props.consequence}</dd>
          </div>
        </dl>

        <div className="mt-4">
          <p className="text-xs font-semibold text-muted">The daemon checks these itself before it sends anything</p>
          <ul className="mt-1 space-y-1">
            {checks.map((c) => (
              <li key={c.label} className="flex items-center justify-between gap-2 rounded-md bg-raised px-2.5 py-1.5 text-sm">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cx(
                      "font-bold",
                      c.state === "ok" ? "text-ok" : c.state === "fail" ? "text-danger-ink" : "text-warn",
                    )}
                  >
                    {c.state === "ok" ? "✓" : c.state === "fail" ? "✕" : "?"}
                  </span>
                  {c.label}
                </span>
                <span className="tabular text-xs text-muted">
                  {c.value}
                  <span className="sr-only">
                    {c.state === "ok" ? " (met)" : c.state === "fail" ? " (not met)" : " (unknown, the daemon will check)"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {checks.some((c) => c.state === "unknown") ? (
            <p className="mt-1 text-xs text-faint">No live reading yet; the daemon reads it before it issues a token.</p>
          ) : null}
        </div>

        {checklist.length > 0 ? (
          <fieldset className="mt-4">
            <legend className="text-xs font-semibold text-muted">You confirm</legend>
            <ul className="mt-1 space-y-1">
              {checklist.map((item, i) => (
                <li key={item}>
                  <label className="flex min-h-[40px] cursor-pointer items-center gap-2 rounded-md px-1 text-sm hover:bg-raised">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={!!ticked[i]}
                      onChange={(e) => setTicked((t) => t.map((v, j) => (j === i ? e.target.checked : v)))}
                    />
                    {item}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        ) : null}

        {liveFail ? (
          <Banner tone="danger" className="mt-4">
            A safety condition isn&apos;t met. Fix it before confirming.
          </Banner>
        ) : null}
        {props.error ? (
          <Banner tone="danger" className="mt-4" title="Not done">
            {props.error}
          </Banner>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <button
            ref={holdBtn}
            type="button"
            disabled={!canHold}
            aria-describedby={`${titleId}-hold`}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              startHold();
            }}
            onPointerUp={stopHold}
            onPointerCancel={stopHold}
            onPointerLeave={stopHold}
            onKeyDown={(e) => {
              if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                e.preventDefault();
                startHold();
              }
            }}
            onKeyUp={(e) => {
              if (e.key === " " || e.key === "Enter") stopHold();
            }}
            onContextMenu={(e) => e.preventDefault()}
            className="relative min-h-[48px] min-w-[200px] overflow-hidden rounded-lg bg-accent px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 bg-white/25"
              style={{ width: `${progress}%` }}
            />
            <span className="relative">
              {busy ? "Working…" : progress > 0 ? "Keep holding…" : (props.confirmLabel ?? "Hold to confirm")}
            </span>
          </button>
        </div>
        <p id={`${titleId}-hold`} className="mt-2 text-right text-xs text-faint">
          Press and hold for 1.5 seconds (mouse, touch, or hold Space / Enter).
        </p>
        <div role="progressbar" aria-label="Hold progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} className="sr-only" />
      </div>
    </div>
  );
}
