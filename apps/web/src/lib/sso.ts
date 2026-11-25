// Sign-in options (password and/or OIDC via AWS Cognito) and the SSO redirect.

import { useEffect, useState } from "react";
import { api, type AuthConfig } from "@/lib/api";

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
