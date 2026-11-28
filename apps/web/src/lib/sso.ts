// Sign-in options (password and/or OIDC via AWS Cognito) and the SSO redirect.

import { useEffect, useState } from "react";
import { api, ApiError, type AuthConfig } from "@/lib/api";

export const SSO_FLAG = "rootcause.sso";

let cached: Promise<AuthConfig> | null = null;

/** /auth/config, fetched once per page load. Falls back to password-only if the API is unreachable. */
export function loadAuthConfig(): Promise<AuthConfig> {
  if (!cached) {
    cached = api<AuthConfig>("/api/v1/auth/config").catch(() => {
      cached = null;
      return { password_enabled: true, oidc: { enabled: false, provider_name: null, logout_url: null }, dev_login: false };
    });
  }
  return cached;
}

export function useAuthConfig(): AuthConfig | null {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  useEffect(() => {
    let live = true;
    void loadAuthConfig().then((c) => {
      if (live) setConfig(c);
    });
    return () => {
      live = false;
    };
  }, []);
  return config;
}

/** Same-site path to come back to after sign-in; anything else becomes /home. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/home";
  return value === "/" ? "/home" : value;
}

/** Sends the browser to the provider. Resolves only if it couldn't (throws ApiError). */
export async function startSso(opts: { returnTo?: string; inviteToken?: string } = {}): Promise<void> {
  const params = new URLSearchParams();
  if (opts.returnTo) params.set("return_to", opts.returnTo);
  if (opts.inviteToken) params.set("invite_token", opts.inviteToken);
  const q = params.toString();
  const { authorize_url } = await api<{ authorize_url: string }>(`/api/v1/auth/oidc/start${q ? `?${q}` : ""}`);
  window.location.assign(authorize_url);
}

/** Error text the provider put on the callback URL (e.g. the user pressed Cancel). */
export function providerError(error: string | null, description: string | null): string | null {
  if (!error) return null;
  if (error === "access_denied") return "Sign-in was cancelled.";
  return description ? `The sign-in provider said: ${description}` : `The sign-in provider returned an error (${error}).`;
}

/** A provider sign-in matched an existing account by email. Nothing was linked (review H3). */
export interface PendingLink {
  link_token: string;
  provider: string;
  email_sent: boolean;
  email_hint: string;
}

const PENDING_LINK = "rootcause.pending-link";

/** The 409 the callback returns when the account holder has to confirm the link. */
export function pendingLinkFrom(err: unknown): PendingLink | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const d = err.detail as Partial<PendingLink> & { code?: string };
  if (!d || typeof d !== "object" || d.code !== "link_required" || typeof d.link_token !== "string") return null;
  return {
    link_token: d.link_token,
    provider: d.provider ?? "single sign-on",
    email_sent: Boolean(d.email_sent),
    email_hint: d.email_hint ?? "",
  };
}

export function savePendingLink(link: PendingLink): void {
  try {
    window.sessionStorage.setItem(PENDING_LINK, JSON.stringify(link));
  } catch {
    /* private mode: the emailed link still works */
  }
}

export function readPendingLink(): PendingLink | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_LINK);
    return raw ? (JSON.parse(raw) as PendingLink) : null;
  } catch {
    return null;
  }
}

export function clearPendingLink(): void {
  try {
    window.sessionStorage.removeItem(PENDING_LINK);
  } catch {
    /* ignore */
  }
}
