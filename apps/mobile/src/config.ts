// Where the app finds RootCause. The app shows the web app itself (same screens,
// same plan gates), so it needs the web address; sign-in and the dongle screens also
// call the API.
//
// Release builds need https addresses: EXPO_PUBLIC_APP_URL and EXPO_PUBLIC_API_URL
// at build time, or `extra.appUrl` / `extra.apiUrl` in app.json. Dev builds may use
// http on this machine: with `adb reverse tcp:3000 tcp:3000` (and 8000, and 8765 for
// the edge daemon) an emulator or USB phone reaches the dev servers at 127.0.0.1.

import Constants from "expo-constants";
import { checkUrl } from "./url";

const extra = (Constants.expoConfig?.extra ?? {}) as { appUrl?: string; apiUrl?: string };
const DEV = typeof __DEV__ !== "undefined" ? __DEV__ : process.env.NODE_ENV !== "production";

function pick(raw: string | undefined, devDefault: string): { url: string; error: string | null } {
  try {
    return { url: checkUrl(raw ?? (DEV ? devDefault : ""), DEV), error: null };
  } catch (e) {
    return { url: devDefault, error: e instanceof Error ? e.message : String(e) };
  }
}

const app = pick(process.env.EXPO_PUBLIC_APP_URL ?? extra.appUrl, "http://127.0.0.1:3000");
const api = pick(process.env.EXPO_PUBLIC_API_URL ?? extra.apiUrl, "http://127.0.0.1:8000");

export const APP_URL = app.url;
export const API_URL = api.url;
/** Set when this build has no usable (https) address; the app says so instead of loading. */
export const CONFIG_ERROR = app.error ?? api.error;
export const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";
