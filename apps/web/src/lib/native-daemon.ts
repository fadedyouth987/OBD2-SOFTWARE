// The edge daemon from the Android app: the phone can't open a WebSocket to the
// workshop PC itself (the PC's certificate is self-signed and must be pinned,
// and the connection carries the phone's device credential), so the app's
// native side holds the TLS connection and this transport relays frames through
// the bridge. Everything above it (Hello with the technician's cloud pairing
// token, leases, the safety interlock and hold-to-confirm) is unchanged: the
// daemon applies exactly the same rules as for the PC's own browser.

import type { EdgeFailure, Transport, TransportFactory } from "@/lib/edge-client";
import { nativeApp, postToNative } from "@/lib/native";

/** Why the app's connection to the PC ended (reported by the app). */
export type NativeCloseReason =
  | "unpaired" // no PC paired on this phone
  | "unreachable" // nothing answered at the paired address
  | "identity" // the PC presented a different certificate than the one pinned
  | "revoked" // the PC refused the phone's credential (removed, or re-keyed)
  | "rejected" // the PC refused the connection for another reason (origin, rate limit)
  | "closed"; // an open connection ended

export type NativeDaemonEvent =
  | { id: string; kind: "open" }
  | { id: string; kind: "message"; text: string }
  | { id: string; kind: "close"; wasOpen: boolean; reason: NativeCloseReason; detail?: string };

interface Receiver {
  deliver(events: NativeDaemonEvent[]): void;
}

declare global {
  interface Window {
    /** The app calls deliver() with what arrived from the PC. */
    RootCauseNativeDaemon?: Receiver;
  }
}

type Handlers = Parameters<TransportFactory>[0];
const live = new Map<string, Handlers>();

function receiver(): Receiver {
  return {
    deliver(events) {
      if (!Array.isArray(events)) return;
      for (const ev of events) {
        const h = ev && typeof ev.id === "string" ? live.get(ev.id) : undefined;
        if (!h) continue;
        if (ev.kind === "open") h.onOpen();
        else if (ev.kind === "message" && typeof ev.text === "string") h.onMessage(ev.text);
        else if (ev.kind === "close") {
          live.delete(ev.id);
          const failure = phoneFailure(ev.reason, ev.detail);
          h.onClose(!!ev.wasOpen, false, failure ? { failure, retry: retryable(ev.reason) } : undefined);
        }
      }
    },
  };
}

function retryable(reason: NativeCloseReason): boolean {
  return reason === "unreachable" || reason === "closed" || reason === "rejected";
}

function pcName(): string {
  return nativeApp()?.daemon?.name ?? "the workshop PC";
}

/** What the technician sees when the phone can't reach the PC, and what to do. */
export function phoneFailure(reason: NativeCloseReason, detail?: string): EdgeFailure | null {
  const where = (() => {
    const d = nativeApp()?.daemon;
    return d?.host ? ` at ${d.host}:${d.port ?? ""}` : "";
  })();
  switch (reason) {
    case "unpaired":
      return {
        kind: "phone",
        code: null,
        needsCode: false,
        message: "This phone isn't paired with a workshop PC, so it can't change the car.",
        hint: "On the PC, open Devices and choose Pair a phone. Then on this phone open Devices, Pair with a PC, and scan the code.",
      };
    case "unreachable":
      return {
        kind: "phone",
        code: null,
        needsCode: false,
        message: `Can't reach ${pcName()}${where}.`,
        hint: "Check the phone is on the workshop Wi-Fi, the PC is on and the edge daemon is running with phone access turned on. The app keeps retrying.",
      };
    case "identity":
      return {
        kind: "phone",
        code: null,
        needsCode: false,
        message: `${pcName()} didn't prove it's the PC this phone was paired with.`,
        hint: "Its certificate changed (it was reinstalled or re-keyed), or another device has its address. Nothing was sent. If you trust the PC, pair again from Devices.",
      };
    case "revoked":
      return {
        kind: "phone",
        code: null,
        needsCode: false,
        message: `${pcName()} no longer accepts this phone.`,
        hint: "It was removed on the PC. Pair again: Devices on the PC, Pair a phone; then Pair with a PC here.",
      };
    case "rejected":
      return {
        kind: "phone",
        code: null,
        needsCode: false,
        message: `${pcName()} refused the connection${detail ? `: ${detail}` : "."}`,
        hint: "Too many attempts block the phone for 5 minutes. Check the PC's allowed web address matches this app's, then retry.",
      };
    case "closed":
      return null;
    default:
      return null;
  }
}

let counter = 0;

/** A transport whose socket lives in the app (pinned TLS to the paired PC). */
export function nativeDaemonTransport(): TransportFactory {
  if (typeof window !== "undefined") window.RootCauseNativeDaemon = receiver();
  return (h): Transport => {
    const id = `d${Date.now().toString(36)}${(counter++).toString(36)}`;
    live.set(id, h);
    if (!postToNative({ type: "daemon-open", id })) {
      live.delete(id);
      queueMicrotask(() => h.onClose(false, false, { failure: phoneFailure("unpaired")!, retry: false }));
      return { send: () => undefined, close: () => undefined };
    }
    return {
      send: (text) => {
        if (live.has(id)) postToNative({ type: "daemon-send", id, text });
      },
      close: () => {
        if (live.delete(id)) postToNative({ type: "daemon-close", id });
      },
    };
  };
}

/** For the app with no PC paired: fails at once with the pairing explanation. */
export function unpairedPhoneTransport(): TransportFactory {
  return (h) => {
    queueMicrotask(() => h.onClose(false, false, { failure: phoneFailure("unpaired")!, retry: false }));
    return { send: () => undefined, close: () => undefined };
  };
}
