"use client";

import { useState } from "react";
import { Banner, Button } from "@/components/ui";
import type { AuthConfig } from "@/lib/api";
import { startSso } from "@/lib/sso";

/** "Continue with AWS Cognito" (or whatever OIDC_PROVIDER_NAME says). Hidden when SSO is off. */
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
        {label ?? `Continue with ${name}`}
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
