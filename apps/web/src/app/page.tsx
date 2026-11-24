import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-[#0c0f14] p-6 text-slate-100">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="rounded-2xl border border-slate-800 border-b-2 border-b-[#e0242f] bg-[#151a22] p-5">
          <h1 className="text-xl font-extrabold tracking-tight">RootCause OBD · Workshop &amp; Fleet Console</h1>
          <p className="mt-1 text-sm text-slate-400">
            Autel-inspired diagnostic suite backed by local Rust edge-daemon (ws://127.0.0.1:8765) and ap-southeast-2 cloud sync.
          </p>
        </header>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Link href="/live" className="min-h-[120px] rounded-2xl border border-slate-800 bg-[#151a22] p-4 hover:border-[#e0242f]">
            <div className="text-sm font-bold text-white">Live Diagnostics &amp; Topology</div>
            <p className="mt-1 text-xs text-slate-400">Auto-Scan ECUs, tamper audit, and Tier A/B 1.5s hold safety interlock.</p>
          </Link>
          <Link href="/can-studio" className="min-h-[120px] rounded-2xl border border-slate-800 bg-[#151a22] p-4 hover:border-[#e0242f]">
            <div className="text-sm font-bold text-white">CAN Studio (11/29-bit)</div>
            <p className="mt-1 text-xs text-slate-400">Live frame matrix and bit-flip reverse engineering.</p>
          </Link>
          <Link href="/copilot/demo-session" className="min-h-[120px] rounded-2xl border border-slate-800 bg-[#151a22] p-4 hover:border-[#e0242f]">
            <div className="text-sm font-bold text-white">AI Root-Cause Copilot</div>
            <p className="mt-1 text-xs text-slate-400">Neo4j wiring graph localization with HIGH/MEDIUM/LOW confidence bands.</p>
          </Link>
          <Link href="/immo" className="min-h-[120px] rounded-2xl border border-slate-800 bg-[#151a22] p-4 hover:border-[#e0242f]">
            <div className="text-sm font-bold text-white">Key learn (sandbox)</div>
            <p className="mt-1 text-xs text-slate-400">AASRA-gated on-board add-key over a BT dongle. Off unless IMMO_FEATURE_ENABLED is set.</p>
          </Link>
        </div>
      </div>
    </main>
  );
}
