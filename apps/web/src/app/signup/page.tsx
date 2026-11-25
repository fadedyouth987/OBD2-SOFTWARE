"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Banner, Button, Field } from "@/components/ui";
import { useAuth } from "@/context/auth";

const MIN_PASSWORD = 10;

function SignUpForm() {
  const { signUp, status } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const rawNext = params.get("next");
  const next = rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/home?welcome=1";
  const [form, setForm] = useState({ display_name: "", workshop_name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (status === "signed_in") router.replace(next);
  }, [status, router, next]);

  const pwError = touched && form.password.length > 0 && form.password.length < MIN_PASSWORD
    ? `Use at least ${MIN_PASSWORD} characters.`
    : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (form.password.length < MIN_PASSWORD) return;
    setBusy(true);
    setError(null);
    try {
      await signUp(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the account.");
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <AuthCard title="Create your workshop" subtitle="You'll be the owner. You can invite your team later.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Your name" autoComplete="name" value={form.display_name} onChange={set("display_name")} />
        <Field label="Workshop name" autoComplete="organization" value={form.workshop_name} onChange={set("workshop_name")} />
        <Field label="Email" type="email" autoComplete="email" required value={form.email} onChange={set("email")} />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={form.password}
          onChange={set("password")}
          onBlur={() => setTouched(true)}
          error={pwError}
          hint={`At least ${MIN_PASSWORD} characters. A short phrase is easiest to remember.`}
        />
        <Button type="submit" variant="primary" busy={busy} className="w-full" disabled={!form.email || !form.password}>
          Create account
        </Button>
        <p className="text-center text-sm text-muted">
          Already have an account?{" "}
          <Link href="/signin" className="font-semibold text-text underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}

export default function SignUpPage() {
  return (
    <Suspense>
      <SignUpForm />
    </Suspense>
  );
}
