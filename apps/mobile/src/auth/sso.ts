// Provider sign-in (Google or AWS Cognito) from the app. Google refuses embedded web
// views, so the provider opens in the phone's browser (a Custom Tab). The web
// callback page sends app-started sign-ins back over rootcause://auth/callback, and
// only this app can redeem them: it sent a challenge to /oidc/start and holds the
// verifier (see the API's migration 015).

export const REDIRECT = "rootcause://auth/callback";
export const APP_STATE_PREFIX = "m.";

export interface PendingLink {
  code: "link_required";
  link_token: string;
  provider: string;
  email_sent: boolean;
  email_hint: string;
  message?: string;
}

export type SsoResult =
  | { kind: "signed-in"; token: string; returnTo: string }
  | { kind: "link-required"; detail: PendingLink }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

export interface SsoDeps {
  apiUrl: string;
  fetch: typeof fetch;
  randomBytes(n: number): Uint8Array;
  sha256Base64(input: string): Promise<string>;
  openAuthSession(url: string, redirect: string): Promise<{ type: string; url?: string }>;
}

export function base64url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function bytesToBase64url(bytes: Uint8Array): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += abc[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += abc[n & 63];
  }
  return out;
}

export function parseCallback(url: string): { code: string; state: string } | null {
  if (!url.startsWith(REDIRECT)) return null;
  const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state || !state.startsWith(APP_STATE_PREFIX)) return null;
  return { code, state };
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function message(body: Record<string, unknown> | null, fallback: string): string {
  const d = body?.detail;
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string") {
    return (d as { message: string }).message;
  }
  return fallback;
}

export async function runSso(deps: SsoDeps, opts: { returnTo?: string; inviteToken?: string } = {}): Promise<SsoResult> {
  const base = deps.apiUrl.replace(/\/$/, "");
  const verifier = bytesToBase64url(deps.randomBytes(32));
  const challenge = base64url(await deps.sha256Base64(verifier));
  const q = new URLSearchParams({ client_challenge: challenge });
  if (opts.returnTo) q.set("return_to", opts.returnTo);
  if (opts.inviteToken) q.set("invite_token", opts.inviteToken);
  let start: Response;
  try {
    start = await deps.fetch(`${base}/api/v1/auth/oidc/start?${q.toString()}`);
  } catch {
    return { kind: "failed", message: "No connection to RootCause. Check your signal and try again." };
  }
  const started = await readJson(start);
  if (!start.ok || typeof started?.authorize_url !== "string") {
    return { kind: "failed", message: message(started, "Single sign-on isn't available right now.") };
  }
  const result = await deps.openAuthSession(started.authorize_url, REDIRECT);
  if (result.type !== "success" || !result.url) return { kind: "cancelled" };
  const back = parseCallback(result.url);
  if (!back) {
    const err = new URLSearchParams(result.url.split("?")[1] ?? "").get("error");
    return err === "access_denied" ? { kind: "cancelled" } : { kind: "failed", message: "Sign-in didn't complete. Try again." };
  }
  let done: Response;
  try {
    done = await deps.fetch(`${base}/api/v1/auth/oidc/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...back, client_verifier: verifier }),
    });
  } catch {
    return { kind: "failed", message: "No connection to RootCause. Check your signal and try again." };
  }
  const body = await readJson(done);
  if (done.status === 409 && (body?.detail as { code?: string } | undefined)?.code === "link_required") {
    return { kind: "link-required", detail: body!.detail as PendingLink };
  }
  if (!done.ok || typeof body?.access_token !== "string") {
    return { kind: "failed", message: message(body, "Sign-in didn't complete. Try again.") };
  }
  const rt = typeof body.return_to === "string" ? body.return_to : "/home";
  return { kind: "signed-in", token: body.access_token, returnTo: rt === "/" ? "/home" : rt };
}
