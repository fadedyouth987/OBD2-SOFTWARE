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
  | { type: "signed-out" };

interface NativeInfo {
  platform: "android";
  appVersion: string;
}

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
