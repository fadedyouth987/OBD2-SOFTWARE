"use client";

import { useEffect, useState } from "react";
import { Badge, Banner, Button, Card, Field, Mono, Spinner, cx } from "@/components/ui";
import { useEdge } from "@/context/edge";
import { TIER_LABEL } from "@/lib/entitlements";

function Countdown({ ms }: { ms: number | null }) {
  const [left, setLeft] = useState(ms ?? 0);
  useEffect(() => {
    setLeft(ms ?? 0);
    if (!ms) return;
    const start = Date.now();
    const t = setInterval(() => setLeft(Math.max(0, ms - (Date.now() - start))), 250);
    return () => clearInterval(t);
  }, [ms]);
  if (!ms) return null;
  return <span className="tabular">retrying in {Math.ceil(left / 1000)} s</span>;
}

export function PairCodeForm() {
  const { pairWithCode, snapshot } = useEdge();
  const [code, setCode] = useState("");
  const valid = /^\d{6}$/.test(code);
  const busy = snapshot.phase === "connecting" || snapshot.phase === "handshaking";
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) pairWithCode(code);
        setCode("");
      }}
    >
      <Field
        label="6-digit pairing code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        className="w-48"
        hint="Codes work once and last 2 minutes."
      />
      <Button type="submit" variant="primary" disabled={!valid} busy={busy} className="mb-5">
        Pair
      </Button>
    </form>
  );
}

/** Connection to the edge daemon: honest state, the fix for each failure, and the mode switch. */
export function DaemonPanel({ compact = false }: { compact?: boolean }) {
  const { snapshot, mode, setMode, retry, lease } = useEdge();
  const { phase, failure, hello } = snapshot;

  let body: React.ReactNode;
  if (phase === "ready" && hello) {
    body = (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="ok">Connected</Badge>
          <span className="text-sm">
            {mode === "browser-sim" ? "Browser demo" : "Edge daemon"} <Mono>{hello.daemon_version}</Mono>
          </span>
        </div>
        {!compact ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <dt className="text-muted">Protocol</dt>
            <dd className="font-mono">{hello.protocol_version}</dd>
            <dt className="text-muted">Safety policy</dt>
            <dd className="font-mono">{hello.policy_version}</dd>
            <dt className="text-muted">Lease</dt>
            <dd>{TIER_LABEL[lease?.lease_tier ?? hello.lease_tier]}</dd>
            <dt className="text-muted">Paired by</dt>
            <dd>
              {snapshot.authMethod === "cloud"
                ? "your sign-in"
                : snapshot.authMethod === "code"
                  ? "pairing code"
                  : "demo"}
            </dd>
          </dl>
        ) : null}
      </div>
    );
  } else if (phase === "connecting" || phase === "handshaking" || phase === "idle") {
    body = <Spinner label={phase === "handshaking" ? "Handshaking with the daemon…" : "Connecting to the edge daemon…"} />;
  } else if (failure?.needsCode) {
    body = (
      <div className="space-y-3">
        <Banner tone="warn" title="Pair this browser">
          {failure.message}
        </Banner>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>
            On this computer, open a terminal and run <Mono className="text-text">edge-daemon pair</Mono>.
          </li>
          <li>Type the 6-digit code it prints below.</li>
        </ol>
        <PairCodeForm />
      </div>
    );
  } else if (failure) {
    body = (
      <div className="space-y-3">
        <Banner
          tone={failure.kind === "unreachable" ? "warn" : "danger"}
          title={failure.message}
          action={
            <Button size="sm" onClick={retry}>
              Retry now
            </Button>
          }
        >
          {failure.hint} {phase === "waiting" ? <Countdown ms={snapshot.retryInMs} /> : null}
        </Banner>
        {failure.kind === "unreachable" && mode === "daemon" && !compact ? (
          <details className="rounded-lg border border-line bg-raised p-3 text-sm">
            <summary className="cursor-pointer font-semibold">How do I install and start the edge daemon?</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
              <li>Install the RootCause edge daemon on the computer that the adapter plugs into.</li>
              <li>
                Start it: <Mono className="text-text">edge-daemon</Mono> (developers: <Mono className="text-text">cargo run -p edge-daemon</Mono>).
              </li>
              <li>Leave this page open. It connects by itself within a few seconds.</li>
            </ol>
          </details>
        ) : null}
      </div>
    );
  } else {
    body = <Spinner label="Waiting…" />;
  }

  return (
    <Card
      title="Edge daemon"
      subtitle="The local service on this computer that talks to the adapter."
      actions={
        <div role="radiogroup" aria-label="Data source" className="flex rounded-lg border border-line p-0.5 text-xs">
          {(
            [
              ["daemon", "Real daemon"],
              ["browser-sim", "Browser demo"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => mode !== m && setMode(m)}
              className={cx(
                "min-h-[36px] rounded-md px-3 font-semibold",
                mode === m ? "bg-raised text-text" : "text-muted hover:text-text",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      {body}
    </Card>
  );
}
