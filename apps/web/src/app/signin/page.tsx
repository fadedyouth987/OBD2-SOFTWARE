"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { OrDivider, SsoButton } from "@/components/SsoButton";
import { Banner, Button, Field, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { useAuthConfig } from "@/lib/sso";

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/home";
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

  useEffect(() => {
    if (status === "signed_in") router.replace(next);
  }, [status, router, next]);

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
        {sessionError && !error ? <Banner tone="info">{sessionError}</Banner> : null}
        <SsoButton config={config} returnTo={next} primary={!passwords} />
        {sso && passwords ? <OrDivider /> : null}
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
