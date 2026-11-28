// Pairing with the workshop PC: one TLS connection to the address in the QR
// code, trusting only the certificate in the QR code, carrying the single-use
// code (Authorization: RootCause-Pair <code>). The daemon answers a single
// LanPairRequest with this phone's own credential and closes the connection.

import { daemonUrl, type PairingLink } from "./link";
import type { DaemonLinkLike } from "./native";
import type { PairedPc } from "./store";

export class PairingError extends Error {}

const REASON_TEXT: Record<string, string> = {
  unreachable:
    "Couldn't reach the PC. Check this phone is on the same Wi-Fi as the PC, phone access is on, and the PC's firewall allows the port.",
  identity:
    "The PC at that address didn't match the pairing code (wrong certificate). Nothing was sent. Make sure you scanned the code on your own PC's screen.",
  revoked: "The PC refused the pairing code. It may have expired (codes last 5 minutes) or already been used. Make a new one.",
  rejected: "The PC refused the connection. Check its allowed web addresses include this app's, then try again.",
  closed: "The PC closed the connection before pairing finished. Make a new code and try again.",
};

export async function pairWithPc(
  link: PairingLink,
  deps: {
    native: DaemonLinkLike;
    origin: string;
    deviceName: string;
    clientVersion: string;
    now?: () => Date;
    timeoutMs?: number;
  },
): Promise<PairedPc> {
  const id = `pair${Date.now().toString(36)}`;
  const requestId = `pair_${Math.random().toString(36).slice(2, 10)}`;
  return new Promise<PairedPc>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      void deps.native.close(id);
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new PairingError("The PC didn't answer in time. Make a new code and try again."))),
      deps.timeoutMs ?? 15000,
    );
    const unsub = deps.native.subscribe({
      onOpen: (e) => {
        if (e.id !== id) return;
        void deps.native.send(
          id,
          JSON.stringify({
            type: "LanPairRequest",
            request_id: requestId,
            device_name: deps.deviceName,
            client_version: deps.clientVersion,
          }),
        );
      },
      onMessage: (e) => {
        if (e.id !== id) return;
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(e.text) as Record<string, unknown>;
        } catch {
          return;
        }
        if (m.type === "LanPairResponse" && m.request_id === requestId) {
          const deviceId = String(m.device_id ?? "");
          const deviceSecret = String(m.device_secret ?? "");
          if (!/^lan_[0-9a-f]{16}$/.test(deviceId) || !/^[A-Za-z0-9_-]{43}$/.test(deviceSecret)) {
            done(() => reject(new PairingError("The PC sent a pairing this app doesn't understand. Update the app.")));
            return;
          }
          if (m.daemon_id !== link.daemonId) {
            done(() => reject(new PairingError("The PC that answered isn't the one in the pairing code.")));
            return;
          }
          const name = typeof m.daemon_name === "string" && m.daemon_name ? m.daemon_name : link.name;
          done(() =>
            resolve({
              host: link.host,
              port: link.port,
              fingerprint: link.fingerprint,
              daemonId: link.daemonId,
              name: name.slice(0, 48),
              deviceId,
              deviceSecret,
              pairedAt: (deps.now?.() ?? new Date()).toISOString(),
            }),
          );
        } else if (m.type === "ErrorResponse") {
          const msg = typeof m.message === "string" ? m.message : "the PC refused";
          done(() => reject(new PairingError(`The PC refused: ${msg}.`)));
        }
      },
      onClose: (e) => {
        if (e.id !== id) return;
        done(() => reject(new PairingError(REASON_TEXT[e.reason] ?? REASON_TEXT.closed)));
      },
    });
    deps.native
      .connect(id, daemonUrl(link.host, link.port), link.fingerprint, `RootCause-Pair ${link.token}`, deps.origin)
      .catch((err: unknown) => done(() => reject(new PairingError(err instanceof Error ? err.message : String(err)))));
  });
}
