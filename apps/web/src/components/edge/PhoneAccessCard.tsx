"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Banner, Button, Card, Mono, Select, Spinner } from "@/components/ui";
import { QrCode } from "@/components/edge/QrCode";
import { useEdge } from "@/context/edge";
import { EdgeRequestError } from "@/lib/edge-client";
import { formatDateTime, relative } from "@/lib/format";
import { nativeApp, useNativeApp } from "@/lib/native";
import type { LanPairOffer, LanStatus } from "@/types/edge-protocol";

/** "ab12 cd34 ..." groups of four, easier to compare by eye. */
export function groupFingerprint(fp: string, groups = 16): string {
  return (fp.match(/.{1,4}/g) ?? []).slice(0, groups).join(" ");
}

function SecondsLeft({ until, onExpire }: { until: string; onExpire: () => void }) {
  const end = useMemo(() => new Date(until).getTime(), [until]);
  const [left, setLeft] = useState(() => Math.max(0, end - Date.now()));
  const fired = useRef(false);
  useEffect(() => {
    const t = setInterval(() => {
      const l = Math.max(0, end - Date.now());
      setLeft(l);
      if (l === 0 && !fired.current) {
        fired.current = true;
        onExpire();
      }
    }, 500);
    return () => clearInterval(t);
  }, [end, onExpire]);
  const s = Math.ceil(left / 1000);
  return (
    <span className="tabular">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

/**
 * On the PC's own browser: turn on, pair and remove phones that reach this
 * daemon over the workshop network. The daemon does the work; nothing here is
 * stored in the browser. Pairing codes are shown, never saved.
 */
export function PhoneAccessCard() {
  const native = useNativeApp();
  const { client, ready, mode, snapshot } = useEdge();
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [offer, setOffer] = useState<LanPairOffer | null>(null);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const knownIds = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const s = await client.request({ type: "LanStatusRequest" });
      setStatus(s);
      setProblem(null);
      // A phone that appears while a code is showing has just paired.
      if (knownIds.current) {
        const added = s.devices.find((d) => !knownIds.current!.has(d.device_id));
        if (added) {
          setOffer(null);
          knownIds.current = null;
          setNotice(`${added.name} is paired. It can now connect to this PC over the workshop network.`);
        }
      }
    } catch (e) {
      setStatus(null);
      if (e instanceof EdgeRequestError && e.code === "PROTOCOL_ERROR") {
        setProblem("This edge daemon is too old to pair phones. Update it on this PC, then come back.");
      } else {
        setProblem(e instanceof Error ? e.message : String(e));
      }
    }
  }, [client]);

  useEffect(() => {
    // Phones can't manage phone access (the daemon refuses); only the PC's browser asks.
    if (ready && mode === "daemon" && !nativeApp()) void refresh();
  }, [ready, mode, refresh, snapshot.generation]);

  useEffect(() => {
    if (!offer || nativeApp()) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [offer, refresh]);

  // Keep "Connected" and "last seen" current while phone access is on (a local call).
  const enabled = !!status?.enabled;
  useEffect(() => {
    if (!enabled || offer || nativeApp()) return;
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [enabled, offer, refresh]);

  const expire = useCallback(() => {
    setOffer(null);
    knownIds.current = null;
    setOfferError("That code expired. Make a new one when the phone is ready to scan.");
  }, []);

  if (native) return null;

  const pair = async () => {
    if (!client || !status) return;
    setBusy(true);
    setOfferError(null);
    setNotice(null);
    try {
      knownIds.current = new Set(status.devices.map((d) => d.device_id));
      const o = await client.request({ type: "LanPairOfferRequest", host: host || null });
      setOffer(o);
    } catch (e) {
      knownIds.current = null;
      setOfferError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!client) return;
    setBusy(true);
    try {
      const s = await client.request({ type: "LanDeviceRevokeRequest", device_id: id });
      setStatus(s);
      setConfirm(null);
      setNotice("Phone removed. It was disconnected and has to pair again to reconnect.");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (mode === "browser-sim") {
    body = <p className="text-sm text-muted">Phone access needs the real edge daemon. Switch the data source to Real daemon.</p>;
  } else if (!ready) {
    body = <p className="text-sm text-muted">Connect the edge daemon on this PC first (above). Then you can pair phones here.</p>;
  } else if (problem) {
    body = (
      <Banner tone="warn" title="Can't read phone access" action={<Button size="sm" onClick={() => void refresh()}>Retry</Button>}>
        {problem}
      </Banner>
    );
  } else if (!status) {
    body = <Spinner label="Reading phone access…" />;
  } else if (!status.enabled) {
    body = (
      <div className="space-y-3 text-sm">
        <Banner tone="info" title="Phone access is off">
          The daemon only listens on this PC. Turn phone access on to let the RootCause app on a phone clear codes and run
          service functions through this PC, with the same safety checks and audit log.
        </Banner>
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>
            As an administrator on this PC, run <Mono className="text-text">edge-daemon lan enable</Mono>.
          </li>
          <li>
            Restart the edge daemon (Windows: <Mono className="text-text">Restart-Service RootCauseEdgeDaemon</Mono>; Linux:{" "}
            <Mono className="text-text">sudo systemctl restart obd2-edge-daemon</Mono>).
          </li>
          <li>
            Allow TCP port <Mono className="text-text">{status.port}</Mono> on this PC&apos;s firewall for the workshop
            (private) network only. The command prints an example.
          </li>
        </ol>
        <Button onClick={() => void refresh()}>Check again</Button>
      </div>
    );
  } else {
    const addressOptions = status.addresses.map((a) => ({ value: a, label: `${a}:${status.port}` }));
    body = (
      <div className="space-y-4 text-sm">
        {notice ? (
          <Banner tone="ok" title="Done">
            {notice}
          </Banner>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted">This PC</dt>
          <dd>{status.daemon_name}</dd>
          <dt className="text-muted">Address</dt>
          <dd className="font-mono">
            {status.addresses.length ? status.addresses.map((a) => `${a}:${status.port}`).join(", ") : "no network address found"}
          </dd>
          <dt className="text-muted">Certificate</dt>
          <dd className="font-mono break-all" title={status.fingerprint ?? undefined}>
            {status.fingerprint ? groupFingerprint(status.fingerprint, 8) + " …" : "—"}
          </dd>
          <dt className="text-muted">Discovery</dt>
          <dd>{status.mdns ? "mDNS on (phones find this PC if its address changes)" : "QR code address only"}</dd>
        </dl>

        {offer ? (
          <div className="space-y-3 rounded-lg border border-line bg-raised p-3">
            <div className="flex flex-wrap items-start gap-4">
              <QrCode rows={offer.qr_rows} label={`Pairing code for ${status.daemon_name} at ${offer.host}:${offer.port}`} />
              <div className="min-w-[200px] flex-1 space-y-2">
                <p className="font-semibold">Scan with the RootCause app</p>
                <ol className="list-decimal space-y-1 pl-5 text-muted">
                  <li>On the phone, open Devices.</li>
                  <li>Tap Pair with a PC and point the camera at this code.</li>
                </ol>
                <p className="text-muted">
                  Works once, for <SecondsLeft until={offer.expires_at} onExpire={expire} />. Anyone who scans it before then can
                  pair, so show it only to your phone.
                </p>
                <p className="text-xs text-muted">
                  The phone checks this PC&apos;s certificate starts <Mono>{groupFingerprint(offer.fingerprint, 4)}</Mono>.
                </p>
                <details className="text-xs">
                  <summary className="min-h-[44px] cursor-pointer py-3 font-semibold">Can&apos;t scan? Show the pairing link</summary>
                  <p className="text-muted">Paste it in the app instead (Pair with a PC, then Paste a link). Treat it like a password.</p>
                  <Mono className="mt-1 block break-all text-text">{offer.pairing_uri}</Mono>
                </details>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setOffer(null);
                    knownIds.current = null;
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            {addressOptions.length > 1 ? (
              <Select
                label="Address the phone uses"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                options={[{ value: "", label: "Best guess" }, ...addressOptions]}
                className="w-56"
              />
            ) : null}
            <Button variant="primary" busy={busy} onClick={() => void pair()} disabled={!status.addresses.length}>
              Pair a phone
            </Button>
          </div>
        )}
        {offerError ? (
          <Banner tone="warn" title="No pairing code">
            {offerError}
          </Banner>
        ) : null}

        <div>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Paired phones</h3>
          {status.devices.length === 0 ? (
            <p className="text-muted">No phones paired yet.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {status.devices.map((d) => (
                <li key={d.device_id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      {d.name}{" "}
                      {d.connected ? <Badge tone="ok">Connected</Badge> : <Badge tone="neutral">Not connected</Badge>}
                    </p>
                    <p className="text-xs text-muted">
                      Paired {formatDateTime(d.paired_at)} · {d.last_seen_at ? `last seen ${relative(d.last_seen_at)}` : "never connected"}
                    </p>
                  </div>
                  {confirm === d.device_id ? (
                    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Remove ${d.name}?`}>
                      <span className="text-xs">Remove {d.name}? It disconnects now.</span>
                      <Button size="sm" variant="danger" busy={busy} onClick={() => void remove(d.device_id)}>
                        Remove
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                        Keep
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" onClick={() => setConfirm(d.device_id)} aria-label={`Remove ${d.name}`}>
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <Card id="phones" title="Phone access" subtitle="Let the RootCause app on a phone work through this PC's daemon over the workshop Wi-Fi.">
      {body}
    </Card>
  );
}
