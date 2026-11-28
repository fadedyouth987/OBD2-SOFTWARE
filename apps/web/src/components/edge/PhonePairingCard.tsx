"use client";

import { Badge, Banner, Button, Card, Mono } from "@/components/ui";
import { useEdge } from "@/context/edge";
import { postToNative, useNativeApp, useNativeDaemon } from "@/lib/native";

/**
 * Only in the Android app: the workshop PC this phone works through. Car
 * changes from the phone run on the PC's edge daemon (its safety checks,
 * hold-to-confirm and audit log), reached over the workshop network with the
 * PC's certificate pinned at pairing.
 */
export function PhonePairingCard() {
  const native = useNativeApp();
  const pc = useNativeDaemon();
  const { snapshot, retry } = useEdge();
  if (!native) return null;
  if (!native.daemon) {
    return (
      <Card title="Workshop PC" subtitle="Changing the car from this phone.">
        <p className="text-sm text-muted">Update the RootCause app to pair this phone with the workshop PC.</p>
      </Card>
    );
  }
  const paired = !!pc?.paired;
  const connected = snapshot.phase === "ready";
  return (
    <Card title="Workshop PC" subtitle="Clearing codes, service functions and key programming run on the PC's edge daemon.">
      <div className="space-y-3 text-sm">
        {paired ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{pc?.name ?? "Workshop PC"}</span>
              {connected ? (
                <Badge tone="ok">Connected</Badge>
              ) : snapshot.phase === "failed" ? (
                <Badge tone="danger">Not connected</Badge>
              ) : (
                <Badge tone="warn">Connecting</Badge>
              )}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted">Address</dt>
              <dd className="font-mono">
                {pc?.host}:{pc?.port}
              </dd>
              <dt className="text-muted">Certificate</dt>
              <dd className="font-mono">{pc?.fingerprint ? `${(pc.fingerprint.match(/.{1,4}/g) ?? []).join(" ")} …` : "—"}</dd>
            </dl>
            {!connected && snapshot.failure ? (
              <Banner tone={snapshot.phase === "failed" ? "danger" : "warn"} title={snapshot.failure.message}>
                {snapshot.failure.hint}
              </Banner>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {!connected ? <Button onClick={retry}>Retry now</Button> : null}
              <Button onClick={() => postToNative({ type: "lan-pair" })}>Pair with a different PC</Button>
              <Button variant="ghost" onClick={() => postToNative({ type: "lan-forget" })}>
                Forget this PC
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-muted">
              This phone isn&apos;t paired with a workshop PC yet, so it can read the car but not change it.
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-muted">
              <li>
                On the PC, open Devices in RootCause and choose <span className="text-text">Pair a phone</span>. (Phone access must be
                on: <Mono className="text-text">edge-daemon lan enable</Mono>.)
              </li>
              <li>On this phone, tap Pair with a PC and scan the code on the PC&apos;s screen.</li>
            </ol>
            <Button variant="primary" className="w-full sm:w-auto" onClick={() => postToNative({ type: "lan-pair" })}>
              Pair with a PC
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
