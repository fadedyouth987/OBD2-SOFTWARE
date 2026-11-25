"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Banner, Button, EmptyState, Mono, Select, Spinner } from "@/components/ui";
import { KIND_INFO, PROTOCOL_LABEL } from "@/components/edge/adapters";
import { useAuth } from "@/context/auth";
import { useEdge } from "@/context/edge";
import { featureAccess } from "@/lib/entitlements";
import type { AdapterInfo, BusProtocol } from "@/types/edge-protocol";

/** Adapters the daemon actually found, with connect / disconnect and safety mode. */
export function AdapterPicker({ onConnected }: { onConnected?: (a: AdapterInfo | null) => void }) {
  const { ready, adapters, adaptersError, refreshAdapters, link, linkError, connectAdapter, disconnectAdapter, lease } =
    useEdge();
  const { me } = useAuth();
  const [protocol, setProtocol] = useState<BusProtocol>("AUTO");
  const [active, setActive] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const activeAccess = featureAccess(me, lease, "UDS_ACTIVE");
  const j2534Access = featureAccess(me, lease, "J2534");

  const sorted = useMemo(
    () =>
      [...(adapters ?? [])].sort((a, b) => {
        const order = ["dongle", "vci", "can", "kline", "virtual"];
        return order.indexOf(KIND_INFO[a.kind].group) - order.indexOf(KIND_INFO[b.kind].group);
      }),
    [adapters],
  );

  if (!ready) {
    return (
      <EmptyState title="Connect the edge daemon first">
        Adapters appear here once the daemon is connected.
      </EmptyState>
    );
  }

  const connect = async (a: AdapterInfo) => {
    setBusyId(a.adapter_id);
    try {
      if (link) await disconnectAdapter();
      await connectAdapter(a.adapter_id, { protocol, safetyMode: active ? "ACTIVE_CONFIRMED" : "SILENT" });
      onConnected?.(a);
    } catch {
      /* linkError shows it */
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Bus protocol" value={protocol} onChange={(e) => setProtocol(e.target.value as BusProtocol)}>
          {Object.entries(PROTOCOL_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <div>
          <span className="block text-xs font-semibold text-muted">Safety mode</span>
          <label className="mt-1 flex min-h-[44px] items-center gap-2 rounded-lg border border-line bg-bg px-3 text-sm">
            <input
              type="checkbox"
              checked={active && activeAccess === "available"}
              disabled={activeAccess !== "available"}
              onChange={(e) => setActive(e.target.checked)}
              className="h-4 w-4"
            />
            Allow confirmed actions (Active mode)
          </label>
          <p className="mt-1 text-xs text-faint">
            {activeAccess === "available"
              ? "Off = read-only. On = clearing codes and service functions are possible, each with its own safety confirmation."
              : activeAccess === "plan_locked"
                ? "Read-only on your plan. Active mode needs Pro or higher."
                : "Your plan includes Active mode; refresh the daemon's lease on Devices to use it."}
          </p>
        </div>
      </div>

      {linkError ? (
        <Banner tone="danger" title="Couldn't connect the adapter">
          {linkError.message} {linkError.hint}
          {linkError.code === "LEASE_REQUIRED" ? (
            <>
              {" "}
              <Link href="/workshop/billing" className="font-semibold underline">
                See plans
              </Link>
            </>
          ) : null}
        </Banner>
      ) : null}
      {adaptersError ? <Banner tone="danger">{adaptersError}</Banner> : null}

      {adapters === null ? (
        <Spinner label="Looking for adapters…" />
      ) : sorted.length === 0 ? (
        <EmptyState
          title="No adapters found"
          action={
            <Button
              size="sm"
              busy={refreshing}
              onClick={async () => {
                setRefreshing(true);
                await refreshAdapters();
                setRefreshing(false);
              }}
            >
              Search again
            </Button>
          }
        >
          Plug in the adapter (or pair the Bluetooth dongle in your computer&apos;s settings), then search again.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {sorted.map((a) => {
            const info = KIND_INFO[a.kind];
            const isLinked = link?.adapterId === a.adapter_id;
            const locked = a.kind === "J2534" && j2534Access !== "available";
            return (
              <li key={a.adapter_id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {a.display_name}
                    {a.kind === "VIRTUAL" ? <Badge tone="info">Simulated</Badge> : null}
                    {isLinked && link?.state === "CONNECTED" ? <Badge tone="ok">Connected</Badge> : null}
                  </p>
                  <p className="text-xs text-muted">
                    {info.label} · <Mono>{a.adapter_id}</Mono>
                    {a.path ? (
                      <>
                        {" "}
                        · <Mono>{a.path}</Mono>
                      </>
                    ) : null}
                  </p>
                  {locked ? (
                    <p className="mt-1 text-xs text-warn">
                      J2534 needs the Workshop plan{j2534Access === "lease_missing" ? " and a fresh lease" : ""}.{" "}
                      <Link href={j2534Access === "lease_missing" ? "/devices#lease" : "/workshop/billing"} className="underline">
                        {j2534Access === "lease_missing" ? "Refresh lease" : "See plans"}
                      </Link>
                    </p>
                  ) : null}
                </div>
                {isLinked ? (
                  <Button size="sm" variant="secondary" busy={busyId === a.adapter_id} onClick={() => void disconnectAdapter().then(() => onConnected?.(null))}>
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="blue"
                    disabled={locked || (busyId !== null && busyId !== a.adapter_id)}
                    busy={busyId === a.adapter_id}
                    onClick={() => void connect(a)}
                  >
                    Connect
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {link?.state === "CONNECTED" ? (
        <p className="text-xs text-muted">
          Connected to <strong className="text-text">{link.adapter?.display_name ?? link.adapterId}</strong> in{" "}
          {link.safetyMode === "ACTIVE_CONFIRMED" ? "Active (confirmed actions allowed)" : "Silent (read-only)"} mode
          {link.batteryV !== null ? `, battery ${link.batteryV.toFixed(1)} V` : ""}.
        </p>
      ) : null}
    </div>
  );
}
