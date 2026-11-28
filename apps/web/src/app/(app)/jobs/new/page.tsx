"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdapterPicker } from "@/components/edge/AdapterPicker";
import { DaemonPanel } from "@/components/edge/DaemonPanel";
import { Badge, Banner, Button, Card, Field, Mono, PageHeader, Spinner, TextArea } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { useEdge } from "@/context/edge";
import { ApiError, api, type Job, type JobList, type VehiclePlatform } from "@/lib/api";
import { parseVin } from "@obd2/core/diag";
import { EdgeRequestError } from "@/lib/edge-client";
import { syntheticSessionId } from "@/lib/job-sync";
import { redactVin } from "@obd2/core/vin";

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export default function NewJobPage() {
  const router = useRouter();
  const { token } = useAuth();
  const edge = useEdge();
  const { ready, link, snapshot, mode } = edge;
  const linked = ready && link?.state === "CONNECTED";

  const [manual, setManual] = useState(false);
  const [vin, setVin] = useState("");
  const [vinSource, setVinSource] = useState<"vehicle" | "typed" | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<VehiclePlatform | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [odometer, setOdometer] = useState("");
  const [customer, setCustomer] = useState("");
  const [complaint, setComplaint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<Job | null>(null);
  const autoRead = useRef<string | null>(null);

  const decode = useCallback(
    async (v: string) => {
      setDecodeError(null);
      try {
        const p = await api<VehiclePlatform>("/api/v1/vehicles/decode", { body: { vin: v }, token });
        setPlatform(p);
        setLabel((cur) => cur || (p.matched ? `${p.make} ${p.model}` : ""));
      } catch (e) {
        setPlatform(null);
        setDecodeError(e instanceof Error ? e.message : "Couldn't decode the VIN.");
      }
    },
    [token],
  );

  const readVin = useCallback(async () => {
    setReading(true);
    setReadError(null);
    try {
      const res = await edge.diag({ tx: 0x7e0, rx: 0x7e8, protocol: "OBD", payloadHex: "0902" });
      const v = res.positive ? parseVin(res.response_hex) : null;
      if (!v) {
        setReadError(
          res.positive
            ? "The vehicle answered but didn't report a valid VIN. Type it from the plate."
            : "The engine ECU doesn't report a VIN on this vehicle. Type it from the plate.",
        );
        return;
      }
      setVin(v);
      setVinSource("vehicle");
      await decode(v);
    } catch (e) {
      setReadError(e instanceof EdgeRequestError ? `${e.message} ${e.hint}` : String(e));
    } finally {
      setReading(false);
    }
  }, [edge, decode]);

  // Read the VIN once each time an adapter connects.
  useEffect(() => {
    if (!linked || !link) return;
    const key = `${snapshot.generation}:${link.adapterId}:${link.since}`;
    if (autoRead.current === key) return;
    autoRead.current = key;
    if (mode === "browser-sim") setLabel((l) => l || "Browser demo car");
    void readVin();
  }, [linked, link, snapshot.generation, mode, readVin]);

  // Is this daemon session already attached to an open job?
  useEffect(() => {
    if (!ready || !snapshot.hello || !token) {
      setExisting(null);
      return;
    }
    const sid = snapshot.hello.session_id;
    api<JobList>("/api/v1/jobs?status=OPEN&limit=200", { token })
      .then((l) => setExisting(l.jobs.find((j) => j.edge_session_id === sid) ?? null))
      .catch(() => setExisting(null));
  }, [ready, snapshot.hello, token]);

  const vinValid = !vin || VIN_RE.test(vin);
  const odoValid = !odometer || (/^\d+$/.test(odometer) && Number(odometer) <= 2_000_000);
  const canCreate = (linked || manual) && vinValid && odoValid && (vin || label.trim());

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const sessionId = linked && snapshot.hello && !existing ? snapshot.hello.session_id : syntheticSessionId();
      const job = await api<Job>("/api/v1/jobs", {
        token,
        body: {
          edge_session_id: sessionId,
          vin: vin || null,
          vehicle_label: label.trim() || (platform?.matched ? `${platform.make} ${platform.model}` : null),
          vehicle_profile: platform?.profile ?? null,
          protocol: linked ? link?.protocol : null,
          adapter_id: linked ? link?.adapterId : null,
          adapter_kind: linked ? (mode === "browser-sim" ? "BROWSER_DEMO" : link?.adapter?.kind ?? null) : null,
          daemon_version: linked ? snapshot.hello?.daemon_version : null,
          lease_tier: linked ? edge.lease?.lease_tier ?? snapshot.hello?.lease_tier : null,
          odometer_km: odometer ? Number(odometer) : null,
          customer_ref: customer.trim() || null,
          complaint: complaint.trim() || null,
        },
      });
      router.push(`/jobs/${job.id}${linked ? "?scan=1" : ""}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Start a job" subtitle="Connect the vehicle, identify it, and note what the customer reported." />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title="1. Connect the vehicle" subtitle="Plug the adapter into the OBD port with the ignition on.">
            {manual ? (
              <Banner tone="info" action={<Button size="sm" onClick={() => setManual(false)}>Use a device</Button>}>
                Starting without a device. You can connect one later from the job.
              </Banner>
            ) : !ready ? (
              <div className="space-y-3">
                <DaemonPanel compact />
                <Button variant="ghost" size="sm" onClick={() => setManual(true)}>
                  No device? Enter the details by hand
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <AdapterPicker />
                {!linked ? (
                  <Button variant="ghost" size="sm" onClick={() => setManual(true)}>
                    No device? Enter the details by hand
                  </Button>
                ) : null}
              </div>
            )}
          </Card>
          {existing ? (
            <Banner
              tone="info"
              title="This connection already belongs to an open job"
              action={
                <Link href={`/jobs/${existing.id}`} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-sm font-semibold underline">
                  Continue {existing.vehicle_label || "that job"}
                </Link>
              }
            >
              Starting a new job is fine too; it gets its own history.
            </Banner>
          ) : null}
        </div>

        <Card title="2. Vehicle and customer">
          <div className="space-y-4">
            {linked ? (
              <div className="rounded-lg border border-line bg-raised p-3">
                {reading ? (
                  <Spinner label="Reading the VIN from the engine ECU…" />
                ) : vinSource === "vehicle" && vin ? (
                  <div className="space-y-1 text-sm">
                    <p className="flex flex-wrap items-center gap-2">
                      <Badge tone="ok">Read from vehicle</Badge> <Mono className="text-base">{vin}</Mono>
                    </p>
                    <p className="text-xs text-muted">
                      Only <Mono>{redactVin(vin)}</Mono> is saved; the full VIN stays on this screen.
                    </p>
                  </div>
                ) : readError ? (
                  <Banner tone="warn" action={<Button size="sm" onClick={() => void readVin()}>Try again</Button>}>
                    {readError}
                  </Banner>
                ) : null}
              </div>
            ) : null}
            <Field
              label="VIN"
              value={vin}
              maxLength={17}
              onChange={(e) => {
                const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
                setVin(v);
                setVinSource("typed");
                setPlatform(null);
                if (VIN_RE.test(v)) void decode(v);
              }}
              error={!vinValid ? "A VIN is 17 letters and digits (no I, O or Q)." : decodeError}
              hint="Read automatically when a vehicle is connected, or type it from the compliance plate."
              className="font-mono"
            />
            {platform ? (
              <p className="text-sm">
                {platform.matched ? (
                  <>
                    <Badge tone="ok">Recognised</Badge> {platform.make} {platform.model}{" "}
                    <span className="text-muted">· {platform.engine}</span>
                  </>
                ) : (
                  <>
                    <Badge>Generic OBD-II</Badge> <span className="text-muted">Not in the platform library; standard OBD-II applies.</span>
                  </>
                )}
              </p>
            ) : null}
            <Field label="Vehicle" placeholder="e.g. 2004 Ford Falcon BA XR6" value={label} onChange={(e) => setLabel(e.target.value)} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Odometer (km)"
                inputMode="numeric"
                value={odometer}
                onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ""))}
                error={!odoValid ? "Enter the odometer in whole kilometres." : null}
              />
              <Field label="Customer / job reference" placeholder="e.g. RO-1042" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            </div>
            <TextArea
              label="Customer complaint"
              placeholder="e.g. Rough idle when cold, check engine light on"
              value={complaint}
              onChange={(e) => setComplaint(e.target.value)}
            />
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" busy={busy} disabled={!canCreate} onClick={() => void create()}>
                {linked ? "Start job and scan" : "Start job"}
              </Button>
              {!linked && !manual ? (
                <span className="text-xs text-muted">Connect a vehicle, or choose to enter the details by hand.</span>
              ) : !vin && !label.trim() ? (
                <span className="text-xs text-muted">Add a VIN or a vehicle description.</span>
              ) : null}
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
