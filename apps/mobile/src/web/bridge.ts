// The small bridge between the web app (in the web view) and the app. The web side
// is apps/web/src/lib/native.ts. Messages are only accepted from the RootCause web
// origin, and only in these shapes.

export type BridgeMessage =
  | { type: "sso-start"; returnTo?: string; inviteToken?: string }
  | { type: "open-dongle" }
  | { type: "open-external"; url: string }
  | { type: "signed-out" }
  | { type: "session"; token: string | null };

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
      return { type: m.type };
    case "open-external":
      return typeof m.url === "string" ? { type: "open-external", url: m.url } : null;
    case "session":
      return { type: "session", token: typeof m.token === "string" && m.token.length < 8192 ? m.token : null };
    default:
      return null;
  }
}

/** Runs before the web app loads: marks the page as being inside the app. */
export function bootstrapScript(appVersion: string): string {
  return `(function(){try{Object.defineProperty(window,"RootCauseNative",{value:Object.freeze({platform:"android",appVersion:${JSON.stringify(
    appVersion,
  )}}),configurable:false});}catch(e){}})();true;`;
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
