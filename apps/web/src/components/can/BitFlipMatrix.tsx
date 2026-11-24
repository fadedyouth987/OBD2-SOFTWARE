"use client";

export interface CanFrameRow {
  ts: string;
  canId: string;
  extended29Bit: boolean;
  dataHex: string;
  label: string;
}

export function BitFlipMatrix({ frames }: { frames: CanFrameRow[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-[#151a22]">
      <table className="w-full text-left font-mono text-xs text-slate-200">
        <thead className="border-b border-slate-800 bg-[#1d2430] text-[11px] text-slate-400">
          <tr>
            <th className="px-3 py-2.5">Timestamp</th>
            <th className="px-3 py-2.5">CAN ID</th>
            <th className="px-3 py-2.5">Format</th>
            <th className="px-3 py-2.5">Payload</th>
            <th className="px-3 py-2.5">Decoded</th>
          </tr>
        </thead>
        <tbody>
          {frames.map((f, idx) => (
            <tr key={`${f.canId}-${idx}`} className="border-b border-slate-800/70">
              <td className="px-3 py-2 text-slate-400">{f.ts}</td>
              <td className="px-3 py-2 font-bold text-blue-400">{f.canId}</td>
              <td className="px-3 py-2">{f.extended29Bit ? "29-bit Ext" : "11-bit Std"}</td>
              <td className="px-3 py-2">{f.dataHex}</td>
              <td className="px-3 py-2 font-sans text-slate-300">{f.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
