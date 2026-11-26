"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SafetyConfirmModal } from "@/components/safety/SafetyConfirmModal";
import { useGatedRunner, useLiveReadings } from "@/components/safety/useGated";
import { AccreditationCard } from "@/components/accreditation/AccreditationCard";
import { Badge, Banner, Button, ButtonLink, Card, Field, Mono, PageHeader, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { useEdge } from "@/context/edge";
import { api, ApiError, type ImmoEligibility, type ImmoProfile, type ImmoProfiles, type ImmoSessionStart } from "@/lib/api";
import { bytesOf, hexId, nrcText, parseVin } from "@/lib/diag";
import { EdgeRequestError } from "@/lib/edge-client";
import { formatTime } from "@/lib/format";
import { IMMO_SESSION_KEY, OPERATION_LABEL, VIN_RE, adapterMatchesProfile, canonicalDeviceId } from "@/lib/immo";

type Step = "vehicle" | "authorise" | "session" | "learn" | "done";
const STEPS: [Step, string][] = [
  ["vehicle", "Vehicle"],
  ["authorise", "Owner authorisation"],
  ["session", "Secure session"],
  ["learn", "Learn key"],
  ["done", "Finish"],
];

const CHECK_TEXT: Record<keyof ImmoEligibility["checks"], { label: string; fix: React.ReactNode }> = {
  feature_enabled: { label: "Key programming is switched on for this service", fix: "It's off on this server. Ask your administrator." },
  plan: { label: "Workshop or Fleet plan", fix: <Link className="underline" href="/workshop/billing">See plans</Link> },
  addon: { label: "IMMO add-on", fix: <Link className="underline" href="/workshop/billing">Add it to your plan</Link> },
  aasra: { label: "Workshop verified with AASRA", fix: <Link className="underline" href="/workshop#accreditation">The owner submits it on the Workshop page</Link> },
  technician: { label: "You're an accredited technician", fix: "Send your AASRA details and evidence below for review." },
};

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.offline ? "You're offline." : e.message;
  if (e instanceof EdgeRequestError) return `${e.message} ${e.hint}`.trim();
  return e instanceof Error ? e.message : String(e);
}

export default function KeyProgrammingPage() {
  const { token, me, refresh } = useAuth();
  const edge = useEdge();
  const live = useLiveReadings();
  const { run } = useGatedRunner(null);
  const [elig, setElig] = useState<ImmoEligibility | null>(null);
  const [eligError, setEligError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ImmoProfiles | null>(null);
  const [profile, setProfile] = useState<ImmoProfile | null>(null);
  const [step, setStep] = useState<Step>("vehicle");
  const [vin, setVin] = useState("");
  const [vinBusy, setVinBusy] = useState(false);
  const [sightedId, setSightedId] = useState(false);
  const [sightedOwnership, setSightedOwnership] = useState(false);
  const [authId, setAuthId] = useState<string | null>(null);
  const [session, setSession] = useState<ImmoSessionStart | null>(null);
  const [interrupted, setInterrupted] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  const connected = edge.ready && edge.link?.state === "CONNECTED";
  const adapterId = edge.link?.adapterId ?? null;

  const loadElig = useCallback(async () => {
    try {
      const e = await api<ImmoEligibility>("/api/v1/immo/eligibility", { token });
      setElig(e);
      setEligError(null);
      if (e.checks.feature_enabled) {
        const p = await api<ImmoProfiles>("/api/v1/immo/profiles", { token });
        setProfiles(p);
        setProfile((cur) => cur ?? p.profiles[0] ?? null);
      }
    } catch (err) {
      setEligError(errText(err));
    }
  }, [token]);

  useEffect(() => {
    void loadElig();
    try {
      setInterrupted(sessionStorage.getItem(IMMO_SESSION_KEY));
    } catch {
      /* ignore */
    }
  }, [loadElig]);

  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [session]);

  const remember = (id: string | null) => {
    try {
      if (id) sessionStorage.setItem(IMMO_SESSION_KEY, id);
      else sessionStorage.removeItem(IMMO_SESSION_KEY);
    } catch {
      /* ignore */
    }
  };

  const abort = async (id: string, reason: string) => {
    setBusy("abort");
    try {
      await api(`/api/v1/immo/sessions/${id}/abort`, { token, body: {} });
    } catch (e) {
      // 409 means it already ended; anything else is shown.
      if (!(e instanceof ApiError && e.status === 409)) setError(errText(e));
    }
    if (connected && adapterId) {
      // Ending the vehicle session makes the daemon drop the immo lease (no silent resume).
      await edge.disconnectAdapter().catch(() => undefined);
    }
    remember(null);
    setInterrupted(null);
    setSession(null);
    setAuthId(null);
    setStep("vehicle");
    setBusy(null);
    setError(reason ? `Session aborted: ${reason}` : null);
  };

  const readVin = async () => {
    setVinBusy(true);
    setError(null);
    try {
      const r = await edge.diag({ tx: 0x7e0, rx: 0x7e8, protocol: "OBD", payloadHex: "0902" });
      const v = r.positive ? parseVin(r.response_hex) : null;
      if (v) setVin(v);
      else setError("The engine ECU didn't report a VIN. Enter it from the compliance plate.");
    } catch (e) {
      setError(errText(e));
    } finally {
      setVinBusy(false);
    }
  };

  const authorise = async () => {
    setBusy("authorise");
    setError(null);
    try {
      const r = await api<{ id: string }>("/api/v1/immo/owner-authorisations", { token, body: { vin } });
      setAuthId(r.id);
      setStep("session");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const startSession = async () => {
    if (!profile || !adapterId || !authId) return;
    setBusy("session");
    setError(null);
    let started: ImmoSessionStart | null = null;
    try {
      started = await api<ImmoSessionStart>("/api/v1/immo/sessions", {
        token,
        body: {
          vin,
          authorisation_id: authId,
          oem: profile.oem,
          operation: profile.operation,
          device_id: canonicalDeviceId(adapterId),
          device_tier: profile.device_tier,
        },
      });
      remember(started.session_id);
      // The daemon binds an immobilizer lease when the vehicle connects, so:
      // disconnect, install the lease, reconnect in Active mode.
      const protocol = edge.link?.protocol;
      await edge.disconnectAdapter();
      await edge.installLease("IMMO", started.lease.token);
      await edge.connectAdapter(adapterId, { protocol, safetyMode: "ACTIVE_CONFIRMED" });
      setSession(started);
      setStep("learn");
    } catch (e) {
      const msg = errText(e);
      if (started) await abort(started.session_id, msg);
      else setError(msg);
    } finally {
      setBusy(null);
    }
  };

  const learn = async () => {
    if (!session) return;
    setBusy("learn");
    setError(null);
    const tx = session.ecu_tx;
    const rx = session.ecu_rx;
    try {
      const tok = await api<{ payload_hex: string }>(`/api/v1/immo/sessions/${session.session_id}/token`, { token, body: {} });
      const enter = await edge.diag({ tx, rx, protocol: "UDS", payloadHex: "1003" });
      if (!enter.positive) throw new Error(`Extended session refused: ${nrcText(enter.nrc?.code ?? 0x10, enter.nrc?.name)}`);
      const ack = `Key programming (${OPERATION_LABEL[profile?.operation ?? ""] ?? profile?.operation}) on immobilizer ${hexId(tx)}`;
      const [seed] = await run([{ label: "Request seed", module: "IMMO", tx, rx, protocol: "UDS", payloadHex: "2701" }], ack);
      if (!seed?.ok) throw new Error(`Security access (request seed) failed: ${seed?.message}`);
      const keyHex = tok.payload_hex.replace(/\s+/g, "").toUpperCase();
      if (!/^([0-9A-F]{2})+$/.test(keyHex) || bytesOf(keyHex).length > 32) throw new Error("The OEM service returned an invalid token.");
      const [key] = await run([{ label: "Send OEM token", module: "IMMO", tx, rx, protocol: "UDS", payloadHex: `2702${keyHex}` }], ack);
      if (!key?.ok) throw new Error(`The immobilizer rejected the OEM token: ${key?.message}`);
      await edge.diag({ tx, rx, protocol: "UDS", payloadHex: "1001" }).catch(() => undefined);
      await api(`/api/v1/immo/sessions/${session.session_id}/complete`, { token, body: {} });
      remember(null);
      setConfirmOpen(false);
      setStep("done");
      void refresh();
    } catch (e) {
      setError(errText(e));
      await edge.diag({ tx, rx, protocol: "UDS", payloadHex: "1001" }).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const header = <PageHeader title="Key programming" subtitle="Guided, AASRA-gated immobilizer key learning with owner authorisation. Every step is audited." />;

  if (eligError) {
    return (
      <>
        {header}
        <Banner tone="danger" title="Couldn't check eligibility" action={<Button size="sm" onClick={() => void loadElig()}>Retry</Button>}>
          {eligError}
        </Banner>
      </>
    );
  }
  if (!elig || !me) {
    return (
      <>
        {header}
        <Skeleton className="h-64" />
      </>
    );
  }

  if (!elig.ready) {
    return (
      <>
        {header}
        <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
          <Card title="Before you can program keys" subtitle="Every check must pass. They're enforced by the service and the daemon, not just this page.">
            <ul className="space-y-2">
              {(Object.keys(CHECK_TEXT) as (keyof ImmoEligibility["checks"])[]).map((k) => (
                <li key={k} className="flex items-start gap-3 rounded-lg border border-line bg-raised p-3 text-sm">
                  <Badge tone={elig.checks[k] ? "ok" : "warn"}>{elig.checks[k] ? "Pass" : "Missing"}</Badge>
                  <span>
                    <span className="block font-semibold">{CHECK_TEXT[k].label}</span>
                    {!elig.checks[k] ? (
                      <span className="text-muted">
                        {k === "technician" && !elig.checks.feature_enabled
                          ? "You can enrol once key programming is switched on."
                          : CHECK_TEXT[k].fix}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          {elig.checks.feature_enabled && !elig.checks.technician ? (
            <AccreditationCard kind="technician" onChange={() => void loadElig()} />
          ) : null}
        </div>
      </>
    );
  }

  const stepIdx = STEPS.findIndex(([s]) => s === step);
  const battery = live.batteryV;
  const minV = profiles?.min_battery_v ?? 13;
  const leaseLeft = session ? Math.max(0, Math.round(session.lease.expires_at - now / 1000)) : null;
  const profileMismatch = !!(profile && adapterId && !adapterMatchesProfile(adapterId, profile.profile_id));

  return (
    <>
      {header}
      {interrupted && !session ? (
        <Banner
          tone="warn"
          title="A key-programming session was interrupted"
          action={
            <Button size="sm" variant="danger" busy={busy === "abort"} onClick={() => void abort(interrupted, "")}>
              Abort it
            </Button>
          }
        >
          Sessions can&apos;t be resumed after a reload or disconnect. Abort it, then start again.
        </Banner>
      ) : null}
      <ol aria-label="Progress" className="mb-4 flex flex-wrap gap-2">
        {STEPS.map(([s, label], i) => (
          <li
            key={s}
            aria-current={s === step ? "step" : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${i < stepIdx ? "border-ok text-ok" : s === step ? "border-accent text-text" : "border-line text-faint"}`}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          {step === "vehicle" ? (
            <Card title="1. Vehicle" subtitle="Connect the adapter, read the VIN, and fit a battery maintainer.">
              <div className="space-y-3">
                {!connected ? (
                  <Banner tone="info" action={<ButtonLink href="/devices" size="sm">Devices</ButtonLink>}>
                    Connect the vehicle first.
                  </Banner>
                ) : null}
                {profiles && profiles.profiles.length > 1 ? (
                  <fieldset>
                    <legend className="text-xs font-semibold text-muted">Procedure</legend>
                    {profiles.profiles.map((p) => (
                      <label key={p.profile_id} className="flex min-h-[44px] items-center gap-2 text-sm">
                        <input type="radio" name="profile" className="h-5 w-5" checked={profile?.profile_id === p.profile_id} onChange={() => setProfile(p)} />
                        {p.oem} · {OPERATION_LABEL[p.operation] ?? p.operation}
                      </label>
                    ))}
                  </fieldset>
                ) : profile ? (
                  <p className="text-sm">
                    Procedure: <span className="font-semibold">{profile.oem}</span> · {OPERATION_LABEL[profile.operation] ?? profile.operation} ({profile.device_tier})
                  </p>
                ) : (
                  <Banner tone="warn">No procedures are allow-listed on this server.</Banner>
                )}
                {profileMismatch ? (
                  <Banner tone="warn">The connected adapter ({adapterId}) isn&apos;t the device for this procedure.</Banner>
                ) : null}
                <div className="flex flex-wrap items-end gap-2">
                  <Field
                    className="min-w-[260px] flex-1"
                    label="VIN"
                    value={vin}
                    maxLength={17}
                    onChange={(e) => setVin(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                    error={vin && !VIN_RE.test(vin) ? "17 characters, no I, O or Q." : null}
                  />
                  <Button variant="ghost" busy={vinBusy} disabled={!connected} onClick={() => void readVin()}>
                    Read from vehicle
                  </Button>
                </div>
                <p className="text-sm">
                  Battery:{" "}
                  {battery === null ? (
                    <Badge>No reading</Badge>
                  ) : battery >= minV ? (
                    <Badge tone="ok">{battery.toFixed(1)} V</Badge>
                  ) : (
                    <Badge tone="danger">{battery.toFixed(1)} V (needs {minV} V; fit a maintainer)</Badge>
                  )}
                </p>
                <Button disabled={!connected || !VIN_RE.test(vin) || !profile || profileMismatch} onClick={() => setStep("authorise")}>
                  Continue
                </Button>
              </div>
            </Card>
          ) : null}

          {step === "authorise" ? (
            <Card title="2. Owner authorisation" subtitle={<>For VIN <Mono>{vin}</Mono></>}>
              <div className="space-y-3">
                <label className="flex min-h-[44px] items-start gap-3 text-sm">
                  <input type="checkbox" className="mt-1 h-5 w-5" checked={sightedId} onChange={(e) => setSightedId(e.target.checked)} />
                  <span>I have sighted the owner&apos;s photo ID.</span>
                </label>
                <label className="flex min-h-[44px] items-start gap-3 text-sm">
                  <input type="checkbox" className="mt-1 h-5 w-5" checked={sightedOwnership} onChange={(e) => setSightedOwnership(e.target.checked)} />
                  <span>I have sighted proof of ownership (registration papers) for this VIN, and the owner asked for this work.</span>
                </label>
                <p className="text-xs text-faint">The authorisation is recorded against your accreditation and expires automatically.</p>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setStep("vehicle")}>
                    Back
                  </Button>
                  <Button busy={busy === "authorise"} disabled={!sightedId || !sightedOwnership} onClick={() => void authorise()}>
                    Record authorisation
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}

          {step === "session" ? (
            <Card title="3. Secure session" subtitle="Issues a short-lived immobilizer lease for this VIN and device, and installs it on the daemon.">
              <div className="space-y-3 text-sm">
                <p>The vehicle connection restarts in Active mode with the lease bound to it. Only one key-programming session can run at a time.</p>
                <div className="flex gap-2">
                  <Button busy={busy === "session"} disabled={!connected} onClick={() => void startSession()}>
                    Start secure session
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}

          {step === "learn" && session ? (
            <Card
              title="4. Learn the key"
              subtitle={`Immobilizer ${hexId(session.ecu_tx)} · lease ends ${formatTime(session.lease.expires_at * 1000)}`}
              actions={
                <Button size="sm" variant="danger" busy={busy === "abort"} onClick={() => void abort(session.session_id, "stopped by technician")}>
                  Abort
                </Button>
              }
            >
              <div className="space-y-3 text-sm">
                <p>
                  The OEM service issues a one-time token for this session. The daemon passes it to the immobilizer; it&apos;s never stored or shown.
                </p>
                {leaseLeft !== null && leaseLeft < 120 ? <Banner tone="warn">{leaseLeft} s left on the lease.</Banner> : null}
                <Button disabled={!connected || busy !== null || leaseLeft === 0} onClick={() => setConfirmOpen(true)}>
                  Learn key…
                </Button>
              </div>
            </Card>
          ) : null}

          {step === "done" ? (
            <Card title="Key learned">
              <div className="space-y-3 text-sm">
                <Banner tone="ok">The immobilizer accepted the new key and the session is closed. Test every key starts the engine.</Banner>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSession(null);
                    setAuthId(null);
                    setVin("");
                    setSightedId(false);
                    setSightedOwnership(false);
                    setStep("vehicle");
                  }}
                >
                  Program another key
                </Button>
              </div>
            </Card>
          ) : null}
        </div>
        <Card title="Rules">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
            <li>Only allow-listed procedures from legitimate OEM channels; no PIN reading or cloning.</li>
            <li>Owner authorisation is required for every VIN.</li>
            <li>Battery at least {minV} V with a maintainer connected for the whole procedure.</li>
            <li>Disconnecting or reloading aborts the session; it can&apos;t be resumed.</li>
            <li>Every step is recorded against your AASRA accreditation.</li>
          </ul>
        </Card>
      </div>

      {confirmOpen && session ? (
        <SafetyConfirmModal
          open
          action="Learn a new key"
          target={`Immobilizer ${hexId(session.ecu_tx)} · VIN ${vin.slice(0, 11)}••••••`}
          consequence="Puts the immobilizer into key-learn using the OEM token. Keep every key for this vehicle with you; a failed or interrupted learn can leave keys unusable until it's repeated."
          tier="A"
          checklist={["Battery maintainer connected", "All existing keys for this vehicle are present", "Vehicle stationary, ignition on, engine off"]}
          live={live}
          busy={busy === "learn"}
          error={error}
          confirmLabel="Hold to learn key"
          onCancel={() => {
            if (busy !== "learn") setConfirmOpen(false);
          }}
          onConfirm={() => void learn()}
        />
      ) : null}
    </>
  );
}
