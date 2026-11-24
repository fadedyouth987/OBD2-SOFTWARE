"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { INITIAL_DIAGNOSTIC_STATE } from "@/store/diagnostic-store";

const CLOUD_API_URL = process.env.NEXT_PUBLIC_CLOUD_API_URL ?? "http://127.0.0.1:8000";

interface VehicleOption {
  profile: string;
  label: string;
}

const FALLBACK_VEHICLES: VehicleOption[] = [
  { profile: "holden_commodore_ve_vf", label: "Holden Commodore VE / VF" },
  { profile: "holden_commodore_vz", label: "Holden Commodore VZ" },
  { profile: "holden_commodore_vn_vy", label: "Holden Commodore VN–VY V6 (ALDL)" },
  { profile: "holden_commodore_vt_vy_ls1", label: "Holden Commodore VT II–VY LS1" },
  { profile: "holden_commodore_zb", label: "Holden Commodore ZB" },
  { profile: "holden_colorado_rg", label: "Holden Colorado RG / Trailblazer" },
  { profile: "ford_falcon_ba_au", label: "Ford Falcon AU / BA / BF" },
  { profile: "ford_falcon_fg_fgx", label: "Ford Falcon FG / FGX & Territory" },
  { profile: "ford_ranger_px3", label: "Ford Ranger PX–PX3 / Everest" },
  { profile: "toyota_hilux_gun126", label: "Toyota Hilux / Prado / LandCruiser" },
  { profile: "toyota_jdm_hybrid_import", label: "Toyota / Lexus JDM Hybrid" },
  { profile: "mazda_bt50_cx5", label: "Mazda CX-5 / BT-50 / Mazda3" },
  { profile: "isuzu_dmax_mux", label: "Isuzu D-Max / MU-X" },
  { profile: "mitsubishi_triton_pajero", label: "Mitsubishi Triton / Pajero / Delica" },
  { profile: "nissan_navara_patrol", label: "Nissan Navara / Patrol / JDM" },
  { profile: "subaru_forester_wrx", label: "Subaru Forester / WRX / Levorg" },
  { profile: "honda_civic_crv_jdm", label: "Honda Civic / CR-V / Fit JDM" },
  { profile: "suzuki_swift_jimny", label: "Suzuki Swift / Jimny / Vitara" },
  { profile: "hyundai_kia_platform", label: "Hyundai / Kia" },
  { profile: "bmw_e90_dcan", label: "BMW E-Series D-CAN" },
  { profile: "vw_audi_mqb", label: "VW / Audi / Skoda MQB" },
  { profile: "mercedes_sprinter_cclass", label: "Mercedes-Benz C-Class / Sprinter" },
  { profile: "landrover_jaguar", label: "Land Rover / Jaguar" },
  { profile: "jeep_ram_stellantis", label: "Jeep / RAM (SGW)" },
  { profile: "gwm_haval_chery", label: "GWM / Haval / Chery" },
  { profile: "byd_ev_phev", label: "BYD Atto 3 / Seal / Shark 6" },
  { profile: "ldv_mg_saic", label: "LDV T60 / MG ZS / MG4" },
];

interface GuidedStep {
  step: string;
  action: string;
  safety_tier: string;
}

interface RankedCause {
  dtc: string;
  confidence_band: "HIGH" | "MEDIUM" | "LOW";
  cited_nodes: string[];
  cited_case_ids: string[];
  hypothesis: string;
  multimeter_test: string;
  guided_steps?: GuidedStep[];
}

interface DiagnosisResult {
  vehicle?: string;
  mode: string;
  quota_charged: boolean;
  fallback_reason?: string;
  shared_circuit_nodes: string[];
  ranked_causes: RankedCause[];
}

export default function CopilotSessionPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params?.sessionId ?? "demo-session";
  const [vehicles, setVehicles] = useState<VehicleOption[]>(FALLBACK_VEHICLES);
  const [profile, setProfile] = useState("ford_ranger_px3");
  const [result, setResult] = useState<DiagnosisResult | null>(null);
  const [question, setQuestion] = useState("I measured 0.0V on the differential pressure sensor 5V ref, what next?");
  const [followupAnswer, setFollowupAnswer] = useState<{ answer: string; recommended_next_step?: string; cited_nodes?: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${CLOUD_API_URL}/api/v1/vehicles`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data?.platforms) && data.platforms.length > 0) {
          setVehicles(
            data.platforms.map((p: { profile: string; make: string; model: string }) => ({
              profile: p.profile,
              label: `${p.make} ${p.model}`,
            }))
          );
        }
      })
      .catch(() => {
        // Keep FALLBACK_VEHICLES when cloud-api is offline
      });
  }, []);

  const runDiagnosis = async (simulateFallback = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${CLOUD_API_URL}/api/v1/diagnose/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dtcs: INITIAL_DIAGNOSTIC_STATE.dtcs.map((d) => d.code),
          vehicle_profile: profile,
          llm_error: simulateFallback ? "upstream_llm_timeout" : null,
        }),
      });
      const data = (await res.json()) as DiagnosisResult;
      setResult(data);
    } catch {
      setError("Cloud API unreachable on :8000 — start uvicorn to run live KG-RAG diagnosis.");
    } finally {
      setLoading(false);
    }
  };

  const askFollowup = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${CLOUD_API_URL}/api/v1/diagnose/${sessionId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          vehicle_profile: profile,
          dtcs: INITIAL_DIAGNOSTIC_STATE.dtcs.map((d) => d.code),
        }),
      });
      const data = await res.json();
      setFollowupAnswer(data);
    } catch {
      setError("Cloud API unreachable on :8000 — start uvicorn to ask the AI copilot.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#0c0f14] p-4 text-slate-100 md:p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold">AI Root-Cause Copilot &amp; Guided Repair (A-DES-4)</h1>
            <p className="text-xs text-slate-400">Session {sessionId} · Make/model-aware Neo4j topology &amp; ap-southeast-2 resolved cases</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={profile} onChange={(e) => setProfile(e.target.value)} className="min-h-[44px] rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs">
              {vehicles.map((v) => (
                <option key={v.profile} value={v.profile}>{v.label}</option>
              ))}
            </select>
            <button type="button" onClick={() => runDiagnosis(false)} disabled={loading} className="min-h-[44px] rounded-xl bg-blue-600 px-3 text-xs font-bold text-white">
              {loading ? "Running..." : "Run KG-RAG Diagnosis"}
            </button>
            <button type="button" onClick={() => runDiagnosis(true)} disabled={loading} className="min-h-[44px] rounded-xl border border-amber-500/40 bg-amber-500/15 px-3 text-xs font-semibold text-amber-300">
              Test A-CEO-1 Fallback
            </button>
            <Link href="/live" className="flex min-h-[44px] items-center rounded-xl bg-[#e0242f] px-4 text-xs font-bold text-white">
              Back to Session
            </Link>
          </div>
        </div>

        {error && <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">{error}</div>}

        {result && (
          <div className="rounded-xl border border-slate-800 bg-[#151a22] p-3 font-mono text-xs flex flex-wrap gap-4">
            {result.vehicle && <span>Vehicle: <strong>{result.vehicle}</strong></span>}
            <span>Mode: <strong>{result.mode}</strong></span>
            <span>Quota Charged: <strong>{String(result.quota_charged)}</strong></span>
            {result.fallback_reason && <span className="text-amber-300">Reason: {result.fallback_reason}</span>}
          </div>
        )}

        {(result?.ranked_causes?.length ? result.ranked_causes : INITIAL_DIAGNOSTIC_STATE.dtcs.map((d) => ({
          dtc: d.code,
          confidence_band: d.confidenceBand,
          cited_nodes: d.citedNodes,
          cited_case_ids: d.citedCases,
          hypothesis: d.title,
          multimeter_test: "Verify <0.2V drop across sensor 5V reference and ground.",
          guided_steps: [],
        }))).map((cause) => (
          <section key={cause.dtc} className="rounded-2xl border border-slate-800 bg-[#151a22] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm font-bold text-red-400">{cause.dtc} · {cause.hypothesis}</span>
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-0.5 font-mono text-xs font-bold text-emerald-300">
                CONFIDENCE: {cause.confidence_band}
              </span>
            </div>
            <p className="text-xs text-slate-300">Test: {cause.multimeter_test}</p>
            {cause.guided_steps && cause.guided_steps.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {cause.guided_steps.map((s) => (
                  <div key={s.step} className="rounded-xl border border-slate-800 bg-[#1d2430] p-2.5 text-xs space-y-1">
                    <div className="flex justify-between font-bold text-slate-200">
                      <span>{s.step}</span>
                      <span className="font-mono text-[10px] text-amber-300">{s.safety_tier}</span>
                    </div>
                    <p className="text-slate-400">{s.action}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2 font-mono text-xs">
              {cause.cited_case_ids.map((c) => (
                <span key={c} className="rounded border border-blue-500/30 bg-blue-500/15 px-2 py-0.5 text-blue-300">{c}</span>
              ))}
              {cause.cited_nodes.map((n) => (
                <span key={n} className="rounded border border-purple-500/30 bg-purple-500/15 px-2 py-0.5 text-purple-300">{n}</span>
              ))}
            </div>
          </section>
        ))}

        <section className="rounded-2xl border border-slate-800 bg-[#151a22] p-4 space-y-3">
          <h2 className="text-sm font-bold">Ask AI Technician Assistant</h2>
          <div className="flex flex-wrap gap-2">
            <input value={question} onChange={(e) => setQuestion(e.target.value)} className="min-h-[44px] flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs" />
            <button type="button" onClick={askFollowup} disabled={loading} className="min-h-[44px] rounded-xl bg-emerald-600 px-4 text-xs font-bold text-white">
              Ask Next Step
            </button>
          </div>
          {followupAnswer && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs space-y-1">
              <p className="text-slate-100">{followupAnswer.answer}</p>
              {followupAnswer.recommended_next_step && <p className="font-mono text-emerald-300">Next: {followupAnswer.recommended_next_step}</p>}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
