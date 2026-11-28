"use client";

import { useState } from "react";
import { Banner, Button } from "@/components/ui";
import type { AuthConfig } from "@/lib/api";
import { startSso } from "@/lib/sso";

function GoogleMark() {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09a7.12 7.12 0 0 1 0-4.18V7.07H2.18A11.99 11.99 0 0 0 1 12c0 1.94.46 3.77 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

/** "Continue with Google" / "Continue with AWS Cognito" (from OIDC config). Hidden when SSO is off. */
export function SsoButton({
  config,
  returnTo,
  inviteToken,
  label,
  primary,
}: {
  config: AuthConfig | null;
  returnTo?: string;
  inviteToken?: string;
  label?: string;
  primary?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!config?.oidc.enabled) return null;
  const name = config.oidc.provider_name ?? "single sign-on";
  const isGoogle = name.trim().toLowerCase() === "google";
  return (
    <div className="space-y-2">
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Button
        variant={primary ? "primary" : "blue"}
        className="w-full"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await startSso({ returnTo, inviteToken });
          } catch (e) {
            setError(e instanceof Error ? e.message : "Couldn't start sign-in.");
            setBusy(false);
          }
        }}
      >
        <span className="inline-flex items-center justify-center gap-2">
          {isGoogle ? <GoogleMark /> : null}
          <span>{label ?? `Continue with ${name}`}</span>
        </span>
      </Button>
    </div>
  );
}

export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs text-faint" aria-hidden>
      <span className="h-px flex-1 bg-line" />
      or
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
