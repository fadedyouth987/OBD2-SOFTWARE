"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BitFlipMatrix, type CanFrameRow } from "@/components/can/BitFlipMatrix";

const INITIAL_FRAMES: CanFrameRow[] = [
  { ts: "21:04:11.104", canId: "0x7E0", extended29Bit: false, dataHex: "02 01 0D 00 00 00 00 00", label: "OBD Speed Request" },
  { ts: "21:04:11.240", canId: "0x18DAF110", extended29Bit: true, dataHex: "04 62 F4 42 37 14 00 00", label: "29-bit UDS Battery 14.1V" },
  { ts: "21:04:11.318", canId: "0x18FECA00", extended29Bit: true, dataHex: "04 FF 32 02 01 00 FF FF", label: "29-bit J1939 DM1 Fault" },
];

export default function CanStudioPage() {
  const [frames, setFrames] = useState<CanFrameRow[]>(INITIAL_FRAMES);
  const [only29Bit, setOnly29Bit] = useState(false);
  const [streaming, setStreaming] = useState(true);

  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => {
      const now = new Date().toISOString().slice(11, 23);
      const rpmByte = ((750 + Math.floor(Math.random() * 80)) * 4) >> 8;
      setFrames((prev) => [
        {
          ts: now,
          canId: Math.random() > 0.5 ? "0x7E8" : "0x18DAF110",
          extended29Bit: Math.random() > 0.5,
          dataHex: `04 41 0C ${rpmByte.toString(16).padStart(2, "0").toUpperCase()} 20 00 00 00`,
          label: "Live Sim Frame",
        },
        ...prev.slice(0, 29),
      ]);
    }, 600);
    return () => clearInterval(timer);
  }, [streaming]);

  const rows = only29Bit ? frames.filter((f) => f.extended29Bit) : frames;

  return (
    <main className="min-h-screen bg-[#0c0f14] p-4 text-slate-100 md:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold">CAN Reverse-Engineering Studio (A-DES-7)</h1>
            <p className="text-xs text-slate-400">Supports 11-bit standard and 29-bit extended CAN identifiers ({rows.length} frames)</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setStreaming((v) => !v)}
              className="min-h-[44px] rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-semibold"
            >
              {streaming ? "Pause Stream" : "Resume Stream"}
            </button>
            <button
              type="button"
              onClick={() => setOnly29Bit((v) => !v)}
              className="min-h-[44px] rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-semibold"
            >
              {only29Bit ? "Showing 29-bit Only" : "Filter 29-bit Extended"}
            </button>
            <Link href="/live" className="flex min-h-[44px] items-center rounded-xl bg-[#e0242f] px-4 text-xs font-bold text-white">
              Back to Live
            </Link>
          </div>
        </div>
        <BitFlipMatrix frames={rows} />
      </div>
    </main>
  );
}
