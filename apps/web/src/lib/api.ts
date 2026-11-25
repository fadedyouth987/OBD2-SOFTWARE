// Cloud API client: one fetch wrapper, typed errors, no silent failures.

import { CLOUD_API_URL } from "@/lib/config";

export class ApiError extends Error {
  /** HTTP status, or 0 when the API could not be reached at all. */
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }

  get offline(): boolean {
    return this.status === 0;
  }

  get quotaExceeded(): boolean {
    return this.status === 429;
  }
}

/** Turns FastAPI's `detail` (string, object or validation list) into one sentence. */
export function detailMessage(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0] as { msg?: string; loc?: unknown[] };
    const field = Array.isArray(first?.loc) ? first.loc[first.loc.length - 1] : undefined;
    if (first?.msg) return field ? `${String(field)}: ${first.msg}` : first.msg;
  }
  if (detail && typeof detail === "object" && "message" in detail) {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
  /** Send a FormData body as-is (multipart upload). */
  form?: FormData;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`${CLOUD_API_URL}${path}`, {
      method: opts.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Can't reach the RootCause cloud. Check your internet connection.");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail ?? data;
    const fallback =
      res.status === 401
        ? "Your session has ended. Sign in again."
        : res.status >= 500
          ? `The cloud API had a problem (HTTP ${res.status}). Try again shortly.`
          : `Request failed (HTTP ${res.status}).`;
    throw new ApiError(res.status, detailMessage(detail, fallback), detail);
  }
  return data as T;
}

// --- Response shapes --------------------------------------------------------

export type PlanTier = "COMMUNITY" | "PRO" | "WORKSHOP" | "FLEET";
export type LeaseFeature = "J2534" | "UDS_ACTIVE" | "CAN_RE_PRO" | "IMMO_PROGRAM";

export interface Workspace {
  tenant_id: string;
  name: string;
  role: string;
  tier: PlanTier;
}

export interface Entitlements {
  tier: PlanTier;
  stored_tier: PlanTier;
  billing_status: string | null;
  immo_entitled: boolean;
  lease_version: number;
  ai_diagnoses: number;
  schematic_pages: number;
  seats: number;
  sites: number;
  features: LeaseFeature[];
  billing_grace_until: string | null;
  trial_ends_at: string | null;
  trial_used: boolean;
}

export interface Me {
  user: { id: string; email: string | null; display_name: string | null; last_login_at: string | null };
  workspace: { tenant_id: string; name: string; role: string; aasra_verified: boolean };
  workspaces: Workspace[];
  entitlements: Entitlements;
  usage: {
    ai_diagnoses_used: number;
    schematic_pages_used: number;
    quota_period_start: string | null;
    quota_timezone: string;
  };
  immo_feature_enabled: boolean;
  dev_login_enabled: boolean;
}

export interface SessionGrant {
  access_token: string;
  expires_at?: number;
  tenant_id: string;
  user_id: string;
  workspaces: Workspace[];
}

export interface JobDtc {
  code: string;
  module: string;
  status: string;
  source: string;
  description: string;
  status_byte: number | null;
}

export interface JobAlert {
  rule_id: string;
  severity: "INFO" | "AMBER" | "RED";
  title: string;
  recommended_test: string;
  evidence_json: Record<string, unknown>;
}

export interface Diagnosis {
  dtcs: string[];
  vehicle_profile: string;
  result: DiagnosisResult;
  at: string;
}

export interface RankedCause {
  dtc: string;
  confidence_band: "HIGH" | "MEDIUM" | "LOW" | string;
  cited_nodes: string[];
  cited_case_ids: string[];
  hypothesis: string;
  multimeter_test: string;
  guided_steps: { step: string; action: string; safety_tier?: string }[];
}

export interface DiagnosisResult {
  session_id: string;
  vehicle: string;
  engine?: string;
  mode: "KG_RAG_SYNTHESIS" | "FALLBACK_NO_LLM" | string;
  fallback_reason?: string;
  shared_circuit_nodes: string[];
  matched_cases: ResolvedCase[];
  ranked_causes: RankedCause[];
  quota_used?: number;
  quota_limit?: number;
}

export interface CopilotAnswer {
  session_id: string;
  vehicle?: string;
  mode: string;
  cited_nodes: string[];
  answer: string;
  recommended_next_step?: string;
  quota_used?: number;
  quota_limit?: number;
}

export interface Closeout {
  summary: string;
  actual_fix: string;
  parts_replaced: string[];
  labour_notes: string;
  recommendations: string;
  dtcs_cleared: boolean;
  case_id: string | null;
  closed_by: string;
  closed_at: string;
}

export interface Job {
  id: string;
  edge_session_id: string | null;
  status: "OPEN" | "CLOSED";
  vehicle_label: string | null;
  vehicle_profile: string | null;
  vin_redacted: string | null;
  odometer_km: number | null;
  protocol: string | null;
  adapter_id: string | null;
  adapter_kind: string | null;
  daemon_version: string | null;
  lease_tier: string | null;
  customer_ref: string | null;
  complaint: string | null;
  dtcs: JobDtc[];
  alerts: JobAlert[];
  diagnosis: Diagnosis | null;
  closeout: Closeout | null;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string | null;
  user_id: string | null;
}

export interface JobList {
  jobs: Job[];
  open: number;
  closed: number;
}

export interface JobReport {
  job: Job;
  workshop: { name: string };
  technician: { display_name: string | null };
  telemetry: {
    samples: number;
    pids: { pid: number; name: string; unit: string; samples: number; min: number; max: number; avg: number }[];
  };
  actions: { seq: number; at: string | null; ecu: string; service: string; tier: string | null; outcome: string; detail: string }[];
  generated_at: string;
}

export interface VehicleModule {
  id: string;
  bus: string;
  tx: string;
  rx: string;
}

export interface VehiclePlatform {
  profile: string;
  make: string;
  model: string;
  engine: string;
  protocols: string[];
  modules: VehicleModule[];
  shared_nodes: string[];
  common_dtcs: Record<string, string>;
  matched?: boolean;
  wmi?: string;
}

export interface ServiceProcedure {
  module: string;
  tx_id: number;
  rx_id: number;
  service: string;
  identifier: string;
  enter_session_hex: string;
  start_hex: string;
  stop_hex: string | null;
  stop_needs_confirmation: boolean;
  exit_session_hex: string;
  expected_seconds: number;
}

export interface ServiceFunction {
  id: string;
  name: string;
  uds_service: string;
  notes: string;
  conditions: "stationary" | "engine_off_battery";
  checklist: string[];
  availability: "simulated" | "no_verified_procedure";
  procedure: ServiceProcedure | null;
}

export interface ServiceFunctionList {
  adapter_id: string | null;
  source: "simulator" | "none";
  note: string;
  functions: ServiceFunction[];
}

export interface TierInfo {
  tier: PlanTier;
  display_name: string;
  monthly_price_aud: number;
  annual_price_aud: number;
  annual_is_10_for_12: boolean;
  ai_diagnoses: number;
  schematic_pages: number;
  seats: number;
  sites: number;
  features: LeaseFeature[];
  description: string;
  immo_addon_available: boolean;
}

export interface Catalog {
  currency: string;
  timezone: string;
  trial_days: number;
  trial_tier: PlanTier;
  trial_requires_card: boolean;
  immo_addon: {
    monthly_price_aud: number;
    annual_price_aud: number;
    eligible_tiers: PlanTier[];
    description: string;
  };
  tiers: TierInfo[];
}

export interface BillingState extends Catalog, Entitlements {
  ai_diagnoses_used: number;
  schematic_pages_used: number;
  quota_period_start: string | null;
  quota_timezone: string;
  has_stripe_customer: boolean;
  role: string;
}

export interface EdgeLeaseGrant {
  token: string;
  kid: string;
  expires_at: number;
  tier: PlanTier;
  features: LeaseFeature[];
}

export interface ResolvedCase {
  case_id: string;
  wmi_vds: string;
  engine_family: string;
  dtcs: string[];
  symptom_summary: string;
  verified_fix: string;
}

export interface ImmoEligibility {
  checks: { feature_enabled: boolean; plan: boolean; addon: boolean; aasra: boolean; technician: boolean };
  ready: boolean;
  technician: {
    status: "not_enrolled" | "pending" | "accredited" | "expired" | "paperwork_expired";
    aasra_member_id: string | null;
    accredited_until: string | null;
  };
}

export interface ImmoProfile {
  oem: string;
  operation: string;
  device_tier: string;
  ecu_tx: number;
  ecu_rx: number;
  profile_id: string;
}

export interface ImmoProfiles {
  min_battery_v: number;
  default_ttl_s: number;
  profiles: ImmoProfile[];
}

export interface ImmoSessionStart {
  session_id: string;
  status: string;
  lease: { token: string; expires_at: number; jti: string; device_id: string };
  ecu_tx: number;
  ecu_rx: number;
  profile_id: string;
}

// --- Team (seats, sites, invites) ---------------------------------------------

export type TeamRole = "OWNER" | "LEAD_TECH" | "TECH";

export interface TeamMember {
  user_id: string;
  email: string;
  display_name: string;
  role: TeamRole;
  site_id: string | null;
  joined_at: string | null;
  you: boolean;
}

export interface TeamInvite {
  id: string;
  email: string;
  role: TeamRole;
  site_id: string | null;
  created_at: string | null;
  expires_at: string;
  expired: boolean;
}

export interface TeamSite {
  id: string;
  name: string;
  members: number;
}

export interface Team {
  can_manage: boolean;
  seats: { used: number; pending: number; limit: number };
  sites_cap: { used: number; limit: number };
  members: TeamMember[];
  invites: TeamInvite[];
  sites: TeamSite[];
}

export interface CreatedInvite {
  invite: TeamInvite;
  token: string;
  invite_url: string;
}

export interface InviteLookup {
  workshop: string;
  email: string;
  role: TeamRole;
  state: "open" | "expired" | "used" | "revoked";
}

export const ROLE_LABEL: Record<TeamRole, string> = { OWNER: "Owner", LEAD_TECH: "Lead technician", TECH: "Technician" };
