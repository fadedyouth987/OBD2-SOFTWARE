"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { OrDivider, SsoButton } from "@/components/SsoButton";
import { Banner, Button, Field, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { api } from "@/lib/api";
import { clearPendingLink, readPendingLink, useAuthConfig, type PendingLink } from "@/lib/sso";

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/home";
}

/** Shown once the account holder is signed in: they choose whether to link the provider. */
function ConfirmLink({ link, next }: { link: PendingLink; next: string }) {
  const { token, me } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = (to: string) => {
    clearPendingLink();
    router.replace(to);
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/auth/oidc/link/confirm", { body: { token: link.link_token }, token });
      done(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Linking didn't complete.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard
      title={`Link ${link.provider}?`}
      subtitle={`After this you can sign in to ${me?.user.email ?? "this account"} with ${link.provider} as well as your password.`}
    >
      <div className="space-y-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Banner tone="info">We&apos;ll email the account&apos;s address to say it was linked.</Banner>
        <Button variant="primary" className="w-full" busy={busy} onClick={confirm}>
          Link {link.provider}
        </Button>
        <Button variant="secondary" className="w-full" disabled={busy} onClick={() => done(next)}>
          Not now
        </Button>
      </div>
    </AuthCard>
  );
}

function SignInForm() {
  const { signIn, status, error: sessionError } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = useAuthConfig();
  const [link, setLink] = useState<PendingLink | null>(null);
  const linking = params.get("link") === "1";

  useEffect(() => {
    if (linking) setLink(readPendingLink());
  }, [linking]);

  useEffect(() => {
    if (status === "signed_in" && !link) router.replace(next);
  }, [status, router, next, link]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  if (link && status === "signed_in") return <ConfirmLink link={link} next={next} />;

  if (!config) {
    return (
      <AuthCard title="Sign in" subtitle="Loading sign-in options…">
        <Skeleton className="h-32" />
      </AuthCard>
    );
  }
  const sso = config.oidc.enabled;
  const passwords = config.password_enabled;
  const subtitle = passwords
    ? sso
      ? `Use ${config.oidc.provider_name ?? "single sign-on"}, or the email and password for your workshop account.`
      : "Use the email and password for your workshop account."
    : `Sign in with ${config.oidc.provider_name ?? "single sign-on"}.`;

  return (
    <AuthCard title="Sign in" subtitle={subtitle}>
      <div className="space-y-4">
        {sessionError && !error && !link ? <Banner tone="info">{sessionError}</Banner> : null}
        {link ? (
          <Banner tone="info" title={`You already have an account`}>
            To use {link.provider} with it, sign in with your password once and confirm.
            {link.email_sent ? ` Or use the link we just emailed to ${link.email_hint}.` : ""} Nothing has been linked yet.
          </Banner>
        ) : (
          <SsoButton config={config} returnTo={next} primary={!passwords} />
        )}
        {sso && passwords && !link ? <OrDivider /> : null}
        {passwords ? (
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <Field
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button type="submit" variant="primary" busy={busy} className="w-full" disabled={!email || !password}>
              Sign in
            </Button>
          </form>
        ) : null}
        {!passwords && !sso ? (
          <Banner tone="danger" title="No way to sign in">
            Password sign-in is off and single sign-on isn&apos;t configured on this server. Ask whoever runs RootCause for your
            workshop.
          </Banner>
        ) : null}
        <p className="text-center text-sm text-muted">
          New workshop?{" "}
          <Link href={`/signup${next !== "/home" ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-semibold text-text underline">
            Create an account
          </Link>
        </p>
      </div>
    </AuthCard>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
