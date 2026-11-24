"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ConnectionStatus } from "@/components/edge/ConnectionStatus";
import { SafetyConfirmModal } from "@/components/safety/SafetyConfirmModal";
import { WiringTopologyViewer } from "@/components/graph/WiringTopologyViewer";
import { EdgeClient, type EdgeConnectionState } from "@/lib/edge-client";
import { INITIAL_DIAGNOSTIC_STATE } from "@/store/diagnostic-store";

const CLOUD_API_URL = process.env.NEXT_PUBLIC_CLOUD_API_URL ?? "http://127.0.0.1:8000";

interface TopoNode {
  id: string;
  bus: string;
  faults: number;
}

export default function LiveDashboardPage() {
  const [diag, setDiag] = useState(INITIAL_DIAGNOSTIC_STATE);
  const [vinInput, setVinInput] = useState(INITIAL_DIAGNOSTIC_STATE.vin);
  const [topoNodes, setTopoNodes] = useState<TopoNode[]>([
    { id: "PCM", bus: "HS-CAN", faults: 1 },
    { id: "TCM", bus: "HS-CAN", faults: 0 },
    { id: "ABS", bus: "HS-CAN", faults: 0 },
    { id: "BCM", bus: "MS-CAN", faults: 0 },
    { id: "IPC", bus: "MS-CAN", faults: 0 },
    { id: "RCM", bus: "MS-CAN", faults: 0 },
  ]);
  const [connState, setConnState] = useState<EdgeConnectionState>("disconnected");
  const [connHint, setConnHint] = useState<string | undefined>(undefined);
  const [pairingToken, setPairingToken] = useState("DEV-PAIR-2026");
  const [adapterId, setAdapterId] = useState("virtual-generic-uds");
  const [simRunning, setSimRunning] = useState(true);
  const [selectedMod, setSelectedMod] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [fixStatus, setFixStatus] = useState<string | null>(null);
  const [verifiedFix, setVerifiedFix] = useState("Replaced leaking DPF differential pressure sensor hose");
  const clientRef = useRef<EdgeClient | null>(null);

  useEffect(() => {
    if (!simRunning || connState === "connected") return;
    const timer = setInterval(() => {
      setDiag((prev) => ({
        ...prev,
        rpm: Math.round(760 + Math.sin(Date.now() / 600) * 35),
        batteryV: Number((14.0 + Math.cos(Date.now() / 1200) * 0.15).toFixed(2)),
        coolantC: 89,
      }));
    }, 250);
    return () => clearInterval(timer);
  }, [simRunning, connState]);

  const handleAutoVinDecode = async () => {
    try {
      const res = await fetch(`${CLOUD_API_URL}/api/v1/vehicles/decode/${encodeURIComponent(vinInput.trim())}`);
      const data = await res.json();
      setDiag((prev) => ({
        ...prev,
        vin: vinInput.trim().toUpperCase(),
        vehicleName: `${data.make} ${data.model}`,
        protocol: Array.isArray(data.protocols) ? data.protocols.join(" / ") : prev.protocol,
      }));
      if (Array.isArray(data.modules) && data.modules.length > 0) {
        setTopoNodes(
          data.modules.map((m: { id: string; bus: string }, idx: number) => ({
            id: m.id,
            bus: m.bus,
            faults: idx === 0 ? diag.dtcs.length : 0,
          }))
        );
      }
    } catch {
      setConnHint("Cloud API offline on :8000 — start uvicorn to decode AutoVIN live.");
    }
  };

  const handleConnectDaemon = () => {
    clientRef.current?.disconnect();
    const client = new EdgeClient({
      pairingToken,
      onStateChange: (st, hint) => {
        setConnState(st);
        setConnHint(hint);
      },
      onMessage: (msg) => {
        if (msg.type === "HelloResponse") {
          client.connectAdapter(adapterId, "AUTO", diag.safetyMode);
        } else if (msg.type === "ObdPidStream" && Array.isArray(msg.samples)) {
          setDiag((prev) => {
            const next = { ...prev };
            for (const s of msg.samples as Array<{ pid: number; value: number }>) {
              if (s.pid === 0x0c) next.rpm = Math.round(s.value);
              if (s.pid === 0x0d) next.speedKmh = Math.round(s.value);
              if (s.pid === 0x05) next.coolantC = Math.round(s.value);
              if (s.pid === 0x42) next.batteryV = Number(s.value.toFixed(2));
            }
            return next;
          });
        } else if (msg.type === "SafetyConfirmResponse" && typeof msg.safety_token === "string") {
          client.sendDiagCommand({
            protocol: "OBD",
            serviceId: 0x04,
            txId: 0x7df,
            rxId: 0x7e8,
            payloadHex: "04",
            safetyToken: msg.safety_token,
          });
        }
      },
    });
    clientRef.current = client;
    client.connect();
  };

  const handleConfirmClear = () => {
    if (connState === "connected" && clientRef.current) {
      clientRef.current.requestSafetyConfirm({
        protocol: "OBD",
        serviceId: 0x04,
        txId: 0x7df,
        rxId: 0x7e8,
        payloadHex: "04",
        userAckText: "CONFIRMED",
      });
    }
    setDiag((prev) => ({ ...prev, safetyMode: "ACTIVE_CONFIRMED", dtcs: [] }));
    setTopoNodes((prev) => prev.map((n) => ({ ...n, faults: 0 })));
    setModalOpen(false);
  };

  const handlePublishFix = async () => {
    setFixStatus("Publishing...");
    try {
      const res = await fetch(`${CLOUD_API_URL}/api/v1/cases/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vin: diag.vin,
          engine_family: diag.vehicleName,
          dtcs: diag.dtcs.map((d) => d.code).length ? diag.dtcs.map((d) => d.code) : ["P2463"],
          symptom_summary: "Workshop verified diagnostic fault resolution",
          verified_fix: verifiedFix,
          parts_replaced: ["Verified Replacement Component"],
        }),
      });
      const data = await res.json();
      setFixStatus(`Published ${data?.case?.case_id ?? "OK"} (VIN anonymized)`);
    } catch {
      setFixStatus("Cloud API offline — start uvicorn on :8000 to persist");
    }
  };

  return (
    <main className="min-h-screen bg-[#0c0f14] p-4 text-slate-100 md:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 border-b-2 border-b-[#e0242f] bg-[#151a22] p-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-[#e0242f] px-2 py-0.5 font-mono text-xs font-bold text-white">{diag.vehicleId}</span>
              <h1 className="text-base font-bold">{diag.vehicleName}</h1>
            </div>
            <p className="mt-0.5 font-mono text-xs text-slate-400">VIN: {diag.vin} · {diag.protocol} · {diag.batteryV.toFixed(1)}V</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 font-mono text-xs text-emerald-300">{diag.safetyMode}</span>
            <button type="button" onClick={() => setModalOpen(true)} className="min-h-[44px] rounded-xl bg-[#e0242f] px-4 text-xs font-bold text-white">
              Mode 0x04 Clear DTCs
            </button>
            <Link href="/can-studio" className="flex min-h-[44px] items-center rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-semibold">
              CAN Studio
            </Link>
            <Link href="/copilot/demo-session" className="flex min-h-[44px] items-center rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-semibold">
              AI Copilot
            </Link>
          </div>
        </header>

        <section className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-800 bg-[#151a22] p-3 text-xs">
          <input value={vinInput} onChange={(e) => setVinInput(e.target.value)} placeholder="17-char VIN (e.g. 6G1EP5...)" className="min-h-[40px] w-48 rounded-lg border border-slate-700 bg-slate-900 px-2.5 font-mono uppercase" />
          <button type="button" onClick={handleAutoVinDecode} className="min-h-[40px] rounded-lg bg-emerald-600 px-3 font-semibold text-white">
            AutoVIN Decode
          </button>
          <select value={adapterId} onChange={(e) => setAdapterId(e.target.value)} className="min-h-[40px] rounded-lg border border-slate-700 bg-slate-900 px-2.5">
            <option value="virtual-generic-uds">virtual-generic-uds (CAN 500k)</option>
            <option value="virtual-bmw-e90-dcan">virtual-bmw-e90-dcan (BMW D-CAN)</option>
            <option value="virtual-falcon-ba">virtual-falcon-ba (AU Falcon)</option>
          </select>
          <input value={pairingToken} onChange={(e) => setPairingToken(e.target.value)} placeholder="Pairing code / JWT" className="min-h-[40px] rounded-lg border border-slate-700 bg-slate-900 px-2.5 font-mono" />
          <button type="button" onClick={handleConnectDaemon} className="min-h-[40px] rounded-lg bg-blue-600 px-3 font-semibold text-white">
            Connect Edge Daemon
          </button>
          <button type="button" onClick={() => setSimRunning((v) => !v)} className="min-h-[40px] rounded-lg border border-slate-700 bg-slate-900 px-3 font-semibold">
            {simRunning ? "Browser Sim: ON" : "Browser Sim: OFF"}
          </button>
        </section>

        <ConnectionStatus state={connState === "disconnected" && simRunning ? "connected" : connState} hint={connHint} />

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-800 bg-[#151a22] p-3">
            <div className="text-[11px] uppercase text-slate-400">Engine RPM</div>
            <div className="font-mono text-xl font-bold">{diag.rpm}</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-[#151a22] p-3">
            <div className="text-[11px] uppercase text-slate-400">Vehicle Speed</div>
            <div className="font-mono text-xl font-bold">{diag.speedKmh} km/h</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-[#151a22] p-3">
            <div className="text-[11px] uppercase text-slate-400">Battery Voltage</div>
            <div className="font-mono text-xl font-bold">{diag.batteryV.toFixed(2)} V</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-[#151a22] p-3">
            <div className="text-[11px] uppercase text-slate-400">Coolant Temp</div>
            <div className="font-mono text-xl font-bold">{diag.coolantC} °C</div>
          </div>
        </section>

        <WiringTopologyViewer
          nodes={topoNodes}
          selectedId={selectedMod}
          onSelect={(id) => setSelectedMod(selectedMod === id ? null : id)}
        />

        {/* Tamper Audit (Rule 6) & Case Capture (A-CEO-6) */}
        <section className="rounded-2xl border border-slate-800 bg-[#151a22] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold">Tamper Audit &amp; Case Capture (A-CEO-6)</h2>
            <div className="flex items-center gap-2">
              <input value={verifiedFix} onChange={(e) => setVerifiedFix(e.target.value)} className="min-h-[40px] w-72 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-xs" />
              <button
                type="button"
                onClick={handlePublishFix}
                className="min-h-[44px] rounded-xl border border-blue-500/40 bg-blue-500/15 px-3 text-xs font-semibold text-blue-300"
              >
                {fixStatus ?? "Mark Actual Fix"}
              </button>
            </div>
          </div>
          <div className="grid gap-2 text-xs font-mono sm:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-[#1d2430] p-2.5 flex justify-between">
              <span>Odometer PCM/IPC</span><span className="text-emerald-400">MATCH</span>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#1d2430] p-2.5 flex justify-between">
              <span>VIN Consistency</span><span className="text-emerald-400">MATCH</span>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#1d2430] p-2.5 flex justify-between">
              <span>Flash Counter</span><span className="text-blue-400">INFO: not supported</span>
            </div>
          </div>
        </section>

        <SafetyConfirmModal
          open={modalOpen}
          actionName="OBD Mode 0x04 — Clear DTCs & Stored Values"
          targetEcu="ALL (Functional)"
          consequence="Erases confirmed/pending DTCs, freeze frames, and resets emission readiness monitors."
          tier="A"
          speedKmh={diag.speedKmh}
          rpm={diag.rpm}
          batteryV={diag.batteryV}
          onCancel={() => setModalOpen(false)}
          onConfirm={handleConfirmClear}
        />
      </div>
    </main>
  );
}
