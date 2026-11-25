"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Banner, Button, Field } from "@/components/ui";
import { useAuth } from "@/context/auth";

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

  return (
    <AuthCard title="Sign in" subtitle="Use the email and password for your workshop account.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {sessionError && !error ? <Banner tone="info">{sessionError}</Banner> : null}
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
        <p className="text-center text-sm text-muted">
          New workshop?{" "}
          <Link href={`/signup${next !== "/home" ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-semibold text-text underline">
            Create an account
          </Link>
        </p>
      </form>
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
