"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Banner, Button, Field, Skeleton, Spinner } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { ApiError, ROLE_LABEL, api, type InviteLookup } from "@/lib/api";

const MIN_PASSWORD = 10;

const STATE_TEXT: Record<Exclude<InviteLookup["state"], "open">, string> = {
  used: "This invite has already been used. If that was you, sign in.",
  revoked: "The workshop cancelled this invite. Ask them for a new one.",
  expired: "This invite has expired. Ask the workshop to send a new one.",
};

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.offline ? "You're offline. Try again when you're connected." : e.message;
  return e instanceof Error ? e.message : fallback;
}

function JoinInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";
  const { status, me, signUp, acceptInvite, signOut } = useAuth();
  const [invite, setInvite] = useState<InviteLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [form, setForm] = useState({ display_name: "", password: "" });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (!token) {
      setLookupError("This link is missing its invite code. Open the full link from your invite.");
      return;
    }
    api<InviteLookup>(`/api/v1/team/invites/lookup?token=${encodeURIComponent(token)}`)
      .then(setInvite)
      .catch((e) => setLookupError(errText(e, "That invite link isn't valid.")));
  }, [token]);

  useEffect(() => {
    if (joined && status === "signed_in") router.replace("/home?joined=1");
  }, [joined, status, router]);

  const here = `/join?token=${encodeURIComponent(token)}`;

  if (lookupError) {
    return (
      <AuthCard title="Invite link problem" subtitle="We couldn't use this invite.">
        <Banner tone="danger">{lookupError}</Banner>
        <p className="mt-4 text-sm text-muted">
          <Link className="underline" href="/signin">Sign in</Link> or <Link className="underline" href="/signup">create your own workshop</Link>.
        </p>
      </AuthCard>
    );
  }
  if (!invite || status === "loading") {
    return (
      <AuthCard title="Joining a workshop" subtitle="Checking your invite…">
        <Skeleton className="h-24" />
      </AuthCard>
    );
  }
  const subtitle = `You've been invited to ${invite.workshop} as a ${ROLE_LABEL[invite.role].toLowerCase()}.`;
  if (invite.state !== "open") {
    return (
      <AuthCard title={`Join ${invite.workshop}`} subtitle={subtitle}>
        <Banner tone="warn">{STATE_TEXT[invite.state]}</Banner>
        <p className="mt-4 text-sm">
          <Link className="underline" href="/signin">Sign in</Link>
        </p>
      </AuthCard>
    );
  }

  if (status === "signed_in" && me) {
    const mine = (me.user.email ?? "").toLowerCase() === invite.email;
    return (
      <AuthCard title={`Join ${invite.workshop}`} subtitle={subtitle}>
        <div className="space-y-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {mine ? (
            <>
              <p className="text-sm text-muted">
                You&apos;re signed in as <span className="font-semibold text-text">{me.user.email}</span>. Joining adds {invite.workshop} to your workshops; you keep {me.workspaces.length === 1 ? "your current one" : "the others"}.
              </p>
              <Button
                variant="primary"
                className="w-full"
                busy={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await acceptInvite(token);
                    setJoined(true);
                  } catch (e) {
                    setError(errText(e, "Couldn't join the workshop."));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Join {invite.workshop}
              </Button>
            </>
          ) : (
            <>
              <Banner tone="warn" title="Different account">
                This invite is for {invite.email}, but you&apos;re signed in as {me.user.email}.
              </Banner>
              <Button className="w-full" onClick={() => signOut()}>
                Sign out and continue as {invite.email}
              </Button>
            </>
          )}
        </div>
      </AuthCard>
    );
  }

  const pwError = touched && form.password.length > 0 && form.password.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : null;
  return (
    <AuthCard title={`Join ${invite.workshop}`} subtitle={subtitle}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setTouched(true);
          if (form.password.length < MIN_PASSWORD) return;
          setBusy(true);
          setError(null);
          try {
            await signUp({ email: invite.email, password: form.password, display_name: form.display_name, workshop_name: "", invite_token: token });
            setJoined(true);
          } catch (err) {
            setError(errText(err, "Couldn't create the account."));
          } finally {
            setBusy(false);
          }
        }}
      >
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Email" type="email" value={invite.email} readOnly hint="The invite is for this email." />
        <Field label="Your name" autoComplete="name" value={form.display_name} onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))} />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={form.password}
          onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
          onBlur={() => setTouched(true)}
          error={pwError}
          hint={`At least ${MIN_PASSWORD} characters.`}
        />
        <Button type="submit" variant="primary" className="w-full" busy={busy} disabled={!form.password}>
          Create account and join
        </Button>
        <p className="text-center text-sm text-muted">
          Already have an account?{" "}
          <Link className="font-semibold text-text underline" href={`/signin?next=${encodeURIComponent(here)}`}>
            Sign in to accept
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}

export default function JoinPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="Joining a workshop" subtitle="Checking your invite…">
          <Spinner label="Loading…" />
        </AuthCard>
      }
    >
      <JoinInner />
    </Suspense>
  );
}
