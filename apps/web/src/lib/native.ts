import { useEffect, useState } from "react";

// The RootCause Android app shows this web app in a web view, so the phone looks and
// works exactly like the website and the plan gates are the same code. The app adds a
// small bridge: `window.RootCauseNative` (set before the page loads) and
// `window.ReactNativeWebView.postMessage`. Nothing here grants anything: the API and
// the daemon still decide what the plan and lease allow.

export type NativeMessage =
  | { type: "sso-start"; returnTo?: string; inviteToken?: string }
  | { type: "open-dongle" }
  | { type: "open-external"; url: string }
  | { type: "signed-out" }
  // Phone access to the workshop PC's edge daemon (see lib/native-daemon.ts).
  | { type: "lan-pair" }
  | { type: "lan-forget" }
  | { type: "daemon-open"; id: string }
  | { type: "daemon-send"; id: string; text: string }
  | { type: "daemon-close"; id: string };

/** The workshop PC this phone is paired with, as the app reports it. */
export interface NativeDaemonInfo {
  paired: boolean;
  /** PC name from the pairing, e.g. "Bay 3 PC". */
  name?: string;
  host?: string;
  port?: number;
  /** First 16 hex digits of the pinned certificate fingerprint, for display. */
  fingerprint?: string;
}

export interface NativeInfo {
  platform: "android";
  appVersion: string;
  /** Present in app versions that can reach the PC over the workshop network. */
  daemon?: NativeDaemonInfo;
  /** Dev builds: no PC paired falls back to loopback (adb reverse tcp:8765). */
  devLoopback?: boolean;
}

/** Fired on window when the app pairs with or forgets a PC. */
export const NATIVE_DAEMON_EVENT = "rootcause-native-daemon";

declare global {
  interface Window {
    RootCauseNative?: NativeInfo;
    ReactNativeWebView?: { postMessage(message: string): void };
  }
}

/** True inside the Android app's web view. */
export function nativeApp(): NativeInfo | null {
  if (typeof window === "undefined") return null;
  return window.RootCauseNative && window.ReactNativeWebView ? window.RootCauseNative : null;
}

/** Sends a message to the app. Returns false outside the app. */
export function postToNative(message: NativeMessage): boolean {
  if (!nativeApp()) return false;
  window.ReactNativeWebView!.postMessage(JSON.stringify(message));
  return true;
}

/**
 * Provider sign-in states the app started begin with "m." (see the API's
 * client_challenge). The callback page, which opens in the phone's browser, hands
 * those back to the app instead of redeeming them; only the app holds the verifier.
 */
export const APP_STATE_PREFIX = "m.";

export function appHandoffUrl(code: string, state: string): string | null {
  if (!state.startsWith(APP_STATE_PREFIX)) return null;
  return `rootcause://auth/callback?${new URLSearchParams({ code, state }).toString()}`;
}

/** nativeApp() after hydration (the server render never knows). */
export function useNativeApp(): NativeInfo | null {
  const [info, setInfo] = useState<NativeInfo | null>(null);
  useEffect(() => setInfo(nativeApp()), []);
  return info;
}

/** The paired PC, kept current as the app pairs or forgets; null outside the app. */
export function useNativeDaemon(): NativeDaemonInfo | null {
  const [info, setInfo] = useState<NativeDaemonInfo | null>(null);
  useEffect(() => {
    const read = () => {
      const app = nativeApp();
      setInfo(app ? { ...(app.daemon ?? { paired: false }) } : null);
    };
    read();
    window.addEventListener(NATIVE_DAEMON_EVENT, read);
    return () => window.removeEventListener(NATIVE_DAEMON_EVENT, read);
  }, []);
  return info;
}

/** A stable key for the paired PC, so the daemon connection restarts when it changes. */
export function nativeDaemonKey(info: NativeDaemonInfo | null | undefined): string {
  if (!info) return "browser";
  return info.paired ? `phone:${info.host ?? ""}:${info.port ?? ""}:${info.fingerprint ?? ""}` : "phone:unpaired";
}
