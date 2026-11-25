"use client";

import Link from "next/link";
import { useState } from "react";

const CLOUD_API_URL = process.env.NEXT_PUBLIC_CLOUD_API_URL ?? "http://127.0.0.1:8000";
const IMMO_ENABLED = process.env.NEXT_PUBLIC_IMMO_FEATURE_ENABLED === "true";
const SANDBOX_VIN = "SBXTESTVAN0000001";

export default function ImmoPage() {
  const [sessionToken, setSessionToken] = useState("");
  const [hint, setHint] = useState("");
  const [memberId, setMemberId] = useState("VSP-TEST-1");
  const [vin, setVin] = useState(SANDBOX_VIN);
  const [deviceId, setDeviceId] = useState("RC-DONGLE-SANDBOX");
  const [authorisationId, setAuthorisationId] = useState("");
  const [jobId, setJobId] = useState("");
  const [leaseToken, setLeaseToken] = useState("");
  const [oemToken, setOemToken] = useState("");

  async function api(path: string, init: RequestInit = {}) {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
    if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await fetch(`${CLOUD_API_URL}${path}`, { ...init, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${res.status}`);
    }
    return data;
  }

  async function signIn() {
    try {
      const data = await api("/api/v1/auth/dev-session", { method: "POST", body: "{}" });
      setSessionToken(data.access_token);
      setHint("Dev session active. Mark AASRA and enrol next.");
    } catch (e) {
      setHint(e instanceof Error ? e.message : "Sign-in failed");
    }
  }

  async function prepare() {
    try {
      await api("/api/v1/auth/dev-mark-aasra", { method: "POST", body: "{}" });
      const today = new Date().toISOString().slice(0, 10);
      const enrol = await api("/api/v1/immo/technicians/enrol", {
        method: "POST",
        body: JSON.stringify({
          aasra_member_id: memberId,
          national_police_check_dated: today,
          declared: true,
        }),
      });
      setHint(enrol.accredited ? "Technician accredited." : "Enrolled but not accredited.");
    } catch (e) {
      setHint(e instanceof Error ? e.message : "Enrolment failed");
    }
  }

  async function authorise() {
    try {
      const data = await api("/api/v1/immo/owner-authorisations", {
        method: "POST",
        body: JSON.stringify({ vin }),
      });
      setAuthorisationId(data.id);
      setHint("Owner authorisation recorded. VIN is not stored in the clear.");
    } catch (e) {
      setHint(e instanceof Error ? e.message : "Authorisation failed");
    }
  }

  async function startJob() {
    try {
      const data = await api("/api/v1/immo/sessions", {
        method: "POST",
        body: JSON.stringify({
          vin,
          authorisation_id: authorisationId,
          oem: "SANDBOX",
          operation: "add_key_onboard",
          device_id: deviceId,
          device_tier: "dongle",
        }),
      });
      setJobId(data.session_id);
      setLeaseToken(data.lease?.token ?? "");
      setHint("Job started. Place the immo lease in EDGE_DATA_DIR/immo_lease.jwt and keep a maintainer on the battery.");
    } catch (e) {
      setHint(e instanceof Error ? e.message : "Start failed");
    }
  }

  async function fetchToken() {
    try {
      const data = await api(`/api/v1/immo/sessions/${jobId}/token`, { method: "POST" });
      setOemToken(data.payload_hex ?? "");
      setHint("Sandbox token received. Do not store it. It is not an OEM algorithm.");
    } catch (e) {
      setHint(e instanceof Error ? e.message : "Token fetch failed");
    }
  }

  async function finish(kind: "complete" | "abort") {
    try {
      const data = await api(`/api/v1/immo/sessions/${jobId}/${kind}`, { method: "POST" });
      setOemToken("");
      setHint(`Session ${data.status}.`);
    } catch (e) {
      setHint(e instanceof Error ? e.message : "Update failed");
    }
  }

  return (
    <main className="min-h-screen bg-[#0c0f14] p-6 text-slate-100">
      <div className="mx-auto max-w-3xl space-y-5">
        <header className="rounded-2xl border border-slate-800 border-b-2 border-b-[#e0242f] bg-[#151a22] p-5">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-extrabold tracking-tight">On-board key learn (sandbox)</h1>
            <Link href="/live" className="text-xs font-semibold text-slate-300 underline">
              Back to Live
            </Link>
          </div>
          <p className="mt-2 text-sm text-slate-400">
            AASRA-gated add-a-key over a Bluetooth dongle. Keys come only from the sandbox OEM
            adapter when dev login is on. No PIN storage, no seed/key algorithms, no cloning.
          </p>
        </header>

        {!IMMO_ENABLED ? (
          <p className="rounded-xl border border-slate-800 bg-[#151a22] p-4 text-sm text-amber-200">
            Immobilizer support is off. Set <code>IMMO_FEATURE_ENABLED=true</code> on the API and{" "}
            <code>NEXT_PUBLIC_IMMO_FEATURE_ENABLED=true</code> for this page, then restart both.
          </p>
        ) : null}

        <section className="space-y-3 rounded-2xl border border-slate-800 bg-[#151a22] p-4 text-sm">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void signIn()}
              className="min-h-[40px] rounded-xl bg-[#e0242f] px-3 text-xs font-bold text-white"
            >
              {sessionToken ? "Dev session active" : "Dev sign-in"}
            </button>
            <button type="button" onClick={() => void prepare()} className="min-h-[40px] rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-semibold">
              Mark AASRA and enrol
            </button>
          </div>
          <label className="block text-xs text-slate-400">
            AASRA member id
            <input value={memberId} onChange={(e) => setMemberId(e.target.value)} className="mt-1 min-h-[40px] w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 font-mono text-slate-100" />
          </label>
          <label className="block text-xs text-slate-400">
            VIN (sandbox default)
            <input value={vin} onChange={(e) => setVin(e.target.value.toUpperCase())} className="mt-1 min-h-[40px] w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 font-mono text-slate-100" />
          </label>
          <label className="block text-xs text-slate-400">
            Dongle / device id
            <input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="mt-1 min-h-[40px] w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 font-mono text-slate-100" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void authorise()} className="min-h-[40px] rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-semibold">
              Record owner authorisation
            </button>
            <button type="button" onClick={() => void startJob()} className="min-h-[40px] rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-semibold">
              Start job
            </button>
            <button type="button" onClick={() => void fetchToken()} className="min-h-[40px] rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-semibold">
              Fetch sandbox token
            </button>
            <button type="button" onClick={() => void finish("complete")} className="min-h-[40px] rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-semibold">
              Complete
            </button>
            <button type="button" onClick={() => void finish("abort")} className="min-h-[40px] rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-semibold">
              Abort
            </button>
          </div>
          {hint ? <p className="text-xs text-slate-300">{hint}</p> : null}
          {authorisationId ? <p className="font-mono text-xs text-slate-500">authorisation {authorisationId}</p> : null}
          {jobId ? <p className="font-mono text-xs text-slate-500">session {jobId}</p> : null}
          {leaseToken ? (
            <p className="break-all font-mono text-[10px] text-slate-500">immo_lease issued (save as immo_lease.jwt, do not share)</p>
          ) : null}
          {oemToken ? (
            <p className="font-mono text-xs text-amber-200">
              payload_hex {oemToken} — use once, do not store
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}
