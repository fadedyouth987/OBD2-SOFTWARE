"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Banner, ButtonLink, Spinner } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { pendingLinkFrom, providerError, safeReturnTo, savePendingLink } from "@/lib/sso";

/** Where the sign-in provider (AWS Cognito) sends the browser back to: OIDC_REDIRECT_URI. */
function Callback() {
  const { completeSso } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // the code is single-use; don't redeem it twice in dev StrictMode
    started.current = true;
    const fromProvider = providerError(params.get("error"), params.get("error_description"));
    const code = params.get("code");
    const state = params.get("state");
    if (fromProvider) {
      setError(fromProvider);
      return;
    }
    if (!code || !state) {
      setError("This page needs the code and state the sign-in provider adds. Start sign-in again.");
      return;
    }
    // Drop the code from the address bar and history.
    window.history.replaceState(null, "", "/auth/callback");
    completeSso(code, state)
      .then((grant) => router.replace(safeReturnTo(grant.return_to)))
      .catch((e: unknown) => {
        const link = pendingLinkFrom(e);
        if (link) {
          // An account with this email already exists. It is never linked on the
          // provider's word: the holder confirms with their password or the emailed link.
          savePendingLink(link);
          router.replace("/signin?link=1");
          return;
        }
        setError(e instanceof Error ? e.message : "Sign-in didn't complete.");
      });
  }, [params, completeSso, router]);

  if (error) {
    return (
      <AuthCard title="Sign-in didn't complete" subtitle="Nothing was changed.">
        <div className="space-y-4">
          <Banner tone="danger">{error}</Banner>
          <ButtonLink href="/signin" variant="primary" className="w-full">
            Back to sign in
          </ButtonLink>
          <p className="text-center text-xs text-muted">
            Still stuck? Ask your workshop owner, or <Link className="underline" href="/signup">create a workshop</Link>.
          </p>
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Signing you in" subtitle="Checking with your sign-in provider…">
      <Spinner label="One moment…" />
    </AuthCard>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="Signing you in" subtitle="Checking with your sign-in provider…">
          <Spinner label="One moment…" />
        </AuthCard>
      }
    >
      <Callback />
    </Suspense>
  );
}
