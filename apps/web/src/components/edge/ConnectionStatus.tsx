"use client";

import type { EdgeConnectionState } from "@/lib/edge-client";

const LABELS: Record<EdgeConnectionState, { title: string; tone: string }> = {
  connected: { title: "Edge Daemon Connected (ws://127.0.0.1:8765)", tone: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" },
  connecting: { title: "Connecting to Local Edge Daemon...", tone: "bg-blue-500/15 text-blue-300 border-blue-500/40" },
  disconnected: { title: "Disconnected", tone: "bg-slate-800 text-slate-300 border-slate-700" },
  daemon_not_running: { title: "Daemon Not Running", tone: "bg-red-500/15 text-red-300 border-red-500/40" },
  origin_blocked: { title: "Browser Blocked Loopback WebSocket", tone: "bg-amber-500/15 text-amber-300 border-amber-500/40" },
  pairing_rejected: { title: "Pairing Code Rejected", tone: "bg-red-500/15 text-red-300 border-red-500/40" },
};

export function ConnectionStatus({ state, hint }: { state: EdgeConnectionState; hint?: string }) {
  const meta = LABELS[state];
  return (
    <div className={`rounded-xl border px-3.5 py-2.5 text-xs ${meta.tone}`} role="status">
      <div className="font-semibold">{meta.title}</div>
      {hint ? <p className="mt-1 opacity-90">{hint}</p> : null}
    </div>
  );
}
