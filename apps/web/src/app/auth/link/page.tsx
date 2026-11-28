"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Banner, Button, ButtonLink, Spinner } from "@/components/ui";
import { api } from "@/lib/api";

/**
 * The emailed "link this sign-in provider" page (review H3). Linking needs a click,
 * not just opening the link, so mail scanners that prefetch URLs can't confirm it.
 * It links only; signing in is done afterwards with the provider.
 */
function LinkFromEmail() {
  const params = useSearchParams();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linked, setLinked] = useState<string | null>(null);

  useEffect(() => {
    const t = params.get("token");
    setToken(t);
    if (t) window.history.replaceState(null, "", "/auth/link");
  }, [params]);

  const confirm = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ provider: string }>("/api/v1/auth/oidc/link/email-confirm", { body: { token } });
      setLinked(res.provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Linking didn't complete.");
    } finally {
      setBusy(false);
    }
  };

  if (linked) {
    return (
      <AuthCard title={`${linked} is linked`} subtitle={`You can now sign in with ${linked} as well as your password.`}>
        <ButtonLink href="/signin" variant="primary" className="w-full">
          Go to sign in
        </ButtonLink>
      </AuthCard>
    );
  }
  if (token === null && !params.get("token")) {
    return (
      <AuthCard title="This link is incomplete" subtitle="Nothing was changed.">
        <Banner tone="danger">Open the link from the email again, or sign in with the provider to get a new one.</Banner>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="Link a sign-in provider?"
      subtitle="Someone signed in with a provider using your account's email. Link it only if that was you."
    >
      <div className="space-y-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Button variant="primary" className="w-full" busy={busy} onClick={confirm}>
          Yes, link it to my account
        </Button>
        <ButtonLink href="/signin" variant="secondary" className="w-full">
          It wasn&apos;t me
        </ButtonLink>
      </div>
    </AuthCard>
  );
}

export default function AuthLinkPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="Link a sign-in provider" subtitle="Loading…">
          <Spinner label="One moment…" />
        </AuthCard>
      }
    >
      <LinkFromEmail />
    </Suspense>
  );
}
