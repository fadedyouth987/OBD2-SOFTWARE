"use client";

import { Badge, Card } from "@/components/ui";
import { useEdge } from "@/context/edge";
import { KIND_INFO } from "@/components/edge/adapters";

const GUIDES: { group: keyof typeof GROUP_TITLE; steps: string[]; limits: string }[] = [
  {
    group: "dongle",
    steps: [
      "Plug the STN or ELM327 dongle into the vehicle's OBD port (under the dash, driver's side).",
      "Bluetooth: pair it in this computer's Bluetooth settings first (PIN is usually 1234 or 0000). USB: plug it in.",
      "It appears in Adapters as a serial port. Connect with protocol Automatic.",
    ],
    limits: "Good for scans, live data and most service functions. Low current, so not for key programming on most cars.",
  },
  {
    group: "vci",
    steps: [
      "Install your VCI vendor's J2534 driver on this Windows PC (Workshop plan).",
      "Connect the VCI to the vehicle and to the PC (USB or Wi-Fi as the vendor describes).",
      "Restart the edge daemon so it loads the pass-thru bridge, then pick the VCI in Adapters.",
    ],
    limits: "For workshop tablets or PCs. DoIP and vendor-only VCIs that don't offer J2534 aren't supported yet.",
  },
  {
    group: "can",
    steps: [
      "Linux: bring the interface up, for example `ip link set can0 up type can bitrate 500000`.",
      "SLCAN/CANable: plug it in; it shows as a serial CAN adapter.",
      "Pick it in Adapters and choose the bus speed if Automatic doesn't find the vehicle.",
    ],
    limits: "Raw CAN access, ideal for CAN Studio on the bench.",
  },
  {
    group: "kline",
    steps: [
      "Use an FTDI-based K-line (KKL) cable for pre-CAN vehicles (roughly before 2006).",
      "Pick KWP2000 fast init or ISO 9141-2 if Automatic can't wake the ECU.",
    ],
    limits: "Slow bus: live data refreshes less often.",
  },
  {
    group: "virtual",
    steps: [
      "The daemon includes simulated vehicles for training: generic UDS, Ford Falcon BA, BMW E90 and an immobilizer sandbox.",
      "Pick one in Adapters. Everything works as it would on a car, clearly marked as simulated.",
    ],
    limits: "Not a real vehicle. Service procedures on virtual cars use the simulator's own identifiers.",
  },
];

const GROUP_TITLE = {
  dongle: "Bluetooth / USB OBD dongle",
  vci: "Workshop tablet or PC + J2534 VCI",
  can: "CAN interface (SocketCAN, SLCAN)",
  kline: "K-line cable",
  virtual: "Virtual vehicles",
} as const;

export function DeviceGuides() {
  const { adapters } = useEdge();
  const count = (group: string) => (adapters ?? []).filter((a) => KIND_INFO[a.kind].group === group).length;
  return (
    <Card title="Set up a device" subtitle="Which hardware to use, and how to get it working.">
      <div className="space-y-2">
        {GUIDES.map((g) => (
          <details key={g.group} className="rounded-lg border border-line bg-raised p-3">
            <summary className="flex min-h-[44px] cursor-pointer flex-wrap items-center gap-2 text-sm font-semibold">
              {GROUP_TITLE[g.group]}
              {adapters ? (
                count(g.group) ? <Badge tone="ok">{count(g.group)} found</Badge> : <Badge>none found</Badge>
              ) : null}
            </summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">
              {g.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <p className="mt-2 text-xs text-faint">{g.limits}</p>
          </details>
        ))}
      </div>
    </Card>
  );
}
