"use client";

import { type TopologyBus } from "@/lib/vin";

export type { TopologyBus };

export interface TopologyNode {
  id: string;
  bus: TopologyBus;
  faults: number;
}

const BUS_GROUPS: TopologyBus[] = ["HS-CAN", "MS-CAN", "OTHER"];

export function WiringTopologyViewer({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: TopologyNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const groups = BUS_GROUPS.filter((bus) => bus !== "OTHER" || nodes.some((n) => n.bus === "OTHER"));
  return (
    <div className={`grid gap-3 ${groups.length > 2 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
      {groups.map((bus) => (
        <div key={bus} className="rounded-2xl border border-slate-800 bg-[#151a22] p-3.5">
          <div className="mb-2.5 font-mono text-xs font-bold text-blue-400">{bus} BUS</div>
          <div className="grid grid-cols-3 gap-2">
            {nodes
              .filter((n) => n.bus === bus)
              .map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onSelect(n.id)}
                  className={`min-h-[48px] rounded-xl border p-2 text-center font-mono text-xs ${
                    selectedId === n.id ? "ring-2 ring-blue-400" : ""
                  } ${
                    n.faults > 0
                      ? "border-red-500/60 bg-red-500/15 text-red-300"
                      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  }`}
                >
                  <div className="font-bold">{n.id}</div>
                  <div className="text-[10px]">{n.faults > 0 ? `ERR · ${n.faults}` : "OK · PASS"}</div>
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
