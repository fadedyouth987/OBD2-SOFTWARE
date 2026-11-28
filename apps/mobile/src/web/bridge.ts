// The small bridge between the web app (in the web view) and the app. The web side
// is apps/web/src/lib/native.ts. Messages are only accepted from the RootCause web
// origin, and only in these shapes.

export type BridgeMessage =
  | { type: "sso-start"; returnTo?: string; inviteToken?: string }
  | { type: "open-dongle" }
  | { type: "open-external"; url: string }
  | { type: "signed-out" }
  | { type: "session"; token: string | null }
  | { type: "lan-pair" }
  | { type: "lan-forget" }
  | { type: "daemon-open"; id: string }
  | { type: "daemon-send"; id: string; text: string }
  | { type: "daemon-close"; id: string };

/** What the web app may know about the paired PC (never the device secret). */
export interface DaemonInfo {
  paired: boolean;
  name?: string;
  host?: string;
  port?: number;
  fingerprint?: string;
}

const CONN_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Daemon frames are small JSON; anything near this is a bug or abuse. */
const MAX_FRAME = 1_000_000;

const SAFE_PATH = /^\/(?!\/)[^\\\s]*$/;

export function parseBridgeMessage(raw: string, fromUrl: string, appOrigin: string): BridgeMessage | null {
  let origin: string;
  try {
    origin = new URL(fromUrl).origin;
  } catch {
    return null;
  }
  if (origin !== appOrigin) return null;
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  switch (m.type) {
    case "sso-start": {
      const returnTo = typeof m.returnTo === "string" && SAFE_PATH.test(m.returnTo) ? m.returnTo : undefined;
      const inviteToken =
        typeof m.inviteToken === "string" && /^[A-Za-z0-9_-]{20,200}$/.test(m.inviteToken) ? m.inviteToken : undefined;
      return { type: "sso-start", returnTo, inviteToken };
    }
    case "open-dongle":
    case "signed-out":
    case "lan-pair":
    case "lan-forget":
      return { type: m.type };
    case "daemon-open":
    case "daemon-close":
      return typeof m.id === "string" && CONN_ID.test(m.id) ? { type: m.type, id: m.id } : null;
    case "daemon-send":
      return typeof m.id === "string" && CONN_ID.test(m.id) && typeof m.text === "string" && m.text.length <= MAX_FRAME
        ? { type: "daemon-send", id: m.id, text: m.text }
        : null;
    case "open-external":
      return typeof m.url === "string" ? { type: "open-external", url: m.url } : null;
    case "session":
      return { type: "session", token: typeof m.token === "string" && m.token.length < 8192 ? m.token : null };
    default:
      return null;
  }
}

/**
 * Runs before the web app loads: marks the page as being inside the app. With
 * `daemon` (builds that can reach the workshop PC) it also says which PC is
 * paired; daemonUpdateScript() changes that later without a reload.
 */
export function bootstrapScript(appVersion: string, daemon?: DaemonInfo, devLoopback = false): string {
  const info = JSON.stringify({ platform: "android", appVersion, ...(devLoopback ? { devLoopback: true } : {}) });
  if (!daemon) {
    return `(function(){try{Object.defineProperty(window,"RootCauseNative",{value:Object.freeze(${info}),configurable:false});}catch(e){}})();true;`;
  }
  return `(function(){try{var d=Object.freeze(${JSON.stringify(daemon)});var i=${info};Object.defineProperty(i,"daemon",{get:function(){return d;},enumerable:true});Object.defineProperty(window,"RootCauseNative",{value:Object.freeze(i),configurable:false});Object.defineProperty(window,"__rootcauseSetDaemon",{value:function(n){d=Object.freeze(n);window.dispatchEvent(new Event(${JSON.stringify(
    DAEMON_EVENT,
  )}));},configurable:false});}catch(e){}})();true;`;
}

/** The web side listens for this (apps/web/src/lib/native.ts NATIVE_DAEMON_EVENT). */
export const DAEMON_EVENT = "rootcause-native-daemon";

/** Tells the web app the paired PC changed (it reconnects through the new one). */
export function daemonUpdateScript(daemon: DaemonInfo): string {
  return `(function(){if(window.__rootcauseSetDaemon){window.__rootcauseSetDaemon(${JSON.stringify(daemon)});}})();true;`;
}

/** Asks the web app for its session token (the dongle screens use the same sign-in). */
export const READ_SESSION_SCRIPT = `(function(){try{window.ReactNativeWebView.postMessage(JSON.stringify({type:"session",token:window.localStorage.getItem("rootcause.session")}));}catch(e){}})();true;`;

const SESSION_KEY = "rootcause.session";
const PENDING_LINK = "rootcause.pending-link";

/** Signs the web app in with a session the app got from provider sign-in. */
export function adoptSessionScript(token: string, returnTo: string): string {
  const path = SAFE_PATH.test(returnTo) ? returnTo : "/home";
  return `(function(){try{window.localStorage.setItem(${JSON.stringify(SESSION_KEY)},${JSON.stringify(
    token,
  )});window.localStorage.setItem("rootcause.sso","1");}catch(e){}window.location.replace(${JSON.stringify(path)});})();true;`;
}

/** An existing account must confirm the link: hand it to the web's /signin?link=1. */
export function pendingLinkScript(detail: unknown): string {
  return `(function(){try{window.sessionStorage.setItem(${JSON.stringify(PENDING_LINK)},${JSON.stringify(
    JSON.stringify(detail),
  )});}catch(e){}window.location.replace("/signin?link=1");})();true;`;
}

/** Shows an error on the web's own sign-in page. */
export function signInErrorScript(message: string): string {
  return `(function(){window.alert(${JSON.stringify(message)});})();true;`;
}
