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

/**
 * Server errors (5xx) show the API's detail only when it reads as a short plain
 * sentence (e.g. a 503 "payments aren't configured"); an unhandled 500, or
 * anything that looks like a stack trace or debug text, gets the fallback.
 */
export function serverErrorMessage(status: number, detail: unknown, fallback: string): string {
  if (status === 500) return fallback;
  const msg = detailMessage(detail, fallback);
  const debugLike = /traceback|exception|\bfile "|\n|\bat \w+\.|stack/i.test(msg);
  return msg.length > 200 || debugLike ? fallback : msg;
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

/** One ID per request, carried web → API → worker and on every log line (Task 5.2). */
export function newRequestId(): string {
  try {
    return `web-${crypto.randomUUID()}`;
  } catch {
    return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Request-ID": newRequestId() };
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
    const message = res.status >= 500 ? serverErrorMessage(res.status, detail, fallback) : detailMessage(detail, fallback);
    throw new ApiError(res.status, message, detail);
  }
  return data as T;
}

// --- Response shapes --------------------------------------------------------

export type PlanTier = "COMMUNITY" | "MOBILE" | "PRO" | "WORKSHOP" | "FLEET";
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

export type Permission =
  | "MANAGE_BILLING"
  | "TRANSFER_OWNERSHIP"
  | "MANAGE_ROLES"
  | "REMOVE_MEMBERS"
  | "MANAGE_SITES"
  | "INVITE_MEMBERS"
  | "INVITE_LEAD_TECHS"
  | "MANAGE_ALL_JOBS"
  | "MANAGE_SHARED_FILES"
  | "SUBMIT_WORKSHOP_ACCREDITATION"
  | "VIEW_TEAM_AUDIT";

export interface Me {
  user: { id: string; email: string | null; display_name: string | null; last_login_at: string | null };
  workspace: {
    tenant_id: string;
    name: string;
    role: string;
    aasra_verified: boolean;
    /** What this role may do here (see services/cloud-api/app/services/permissions.py). */
    permissions?: Permission[];
  };
  /** Operator of this RootCause deployment (accreditation review, procedure imports). */
  platform_admin?: boolean;
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
  /** Whether diagnoses use an AI model (counts against quota) or only the free built-in rules. */
  ai?: { model_configured: boolean; model_label: string | null };
}

export interface SessionGrant {
  access_token: string;
  expires_at?: number;
  tenant_id: string;
  user_id: string;
  workspaces: Workspace[];
}

export interface AuthConfig {
  password_enabled: boolean;
  oidc: { enabled: boolean; provider_name: string | null; logout_url: string | null };
  dev_login: boolean;
}

export interface OidcGrant extends SessionGrant {
  return_to: string;
  created: boolean;
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

/** Which engine produced an answer: the AI model (uses quota) or the built-in rules (free). */
export interface AnalysisInfo {
  analysis?: "llm" | "rules";
  /** e.g. "Amazon Bedrock · …" or "Built-in rules". */
  analysis_label?: string;
  /** True only when a real model diagnosis was counted against the monthly quota. */
  quota_charged?: boolean;
  /** Why the rules ran instead of the model: not_configured | quota_exhausted | llm_error. */
  fallback_reason?: string | null;
  /** Plain-English version of fallback_reason for the UI. */
  fallback_text?: string | null;
  quota_used?: number;
  quota_limit?: number;
}

export interface DiagnosisResult extends AnalysisInfo {
  session_id: string;
  vehicle: string;
  engine?: string;
  mode: "LLM" | "RULES" | string;
  /** Model-written overview (LLM runs only). */
  summary?: string | null;
  shared_circuit_nodes: string[];
  matched_cases: ResolvedCase[];
  ranked_causes: RankedCause[];
}

export interface CopilotAnswer extends AnalysisInfo {
  session_id: string;
  vehicle?: string;
  mode: string;
  cited_nodes: string[];
  answer: string;
  recommended_next_step?: string;
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
  /** Vehicle identity licensed procedures match on; prefilled from the VIN, confirmed by the tech. */
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  model_year?: number | null;
  dtcs: JobDtc[];
  alerts: JobAlert[];
  diagnosis: Diagnosis | null;
  closeout: Closeout | null;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string | null;
  user_id: string | null;
  technician_name?: string | null;
  /** The signed-in user may edit/close this job (their own, or lead tech / owner). */
  can_edit?: boolean;
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
  availability: "simulated" | "licensed" | "no_verified_procedure";
  procedure: ServiceProcedure | null;
  /** Licensed source details (licensed procedures only). */
  source?: ProcedureSourceInfo | null;
}

export interface ProcedureSourceInfo {
  name: string;
  licence: string;
  licence_url: string | null;
  source_ref: string;
  version: number;
  record_id: string;
  imported_at: string | null;
  notes: string | null;
}

export interface ServiceFunctionList {
  adapter_id: string | null;
  source: "simulator" | "licensed" | "none";
  note: string;
  vehicle?: { make: string; model: string; year: number | null } | null;
  /** Active licensed procedures on this server (any vehicle). */
  licensed_catalogue?: number;
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

export interface TeamAbilities {
  invite: boolean;
  invite_roles: TeamRole[];
  revoke_invites: boolean;
  change_roles: boolean;
  remove_members: boolean;
  manage_sites: boolean;
  transfer_ownership: boolean;
  view_history: boolean;
}

export interface OwnershipTransfer {
  id: string;
  from_user_id: string;
  from_name: string;
  to_user_id: string;
  to_name: string;
  created_at: string | null;
  expires_at: string;
  for_you: boolean;
}

export interface TeamAuditEvent {
  id: number;
  at: string | null;
  action: string;
  actor: string | null;
  subject: string | null;
  detail: Record<string, unknown>;
}

export interface EmailResult {
  sent: boolean;
  provider: string;
  error: string | null;
}

export interface Team {
  can_manage: boolean;
  abilities?: TeamAbilities;
  email_enabled?: boolean;
  ownership_transfer?: OwnershipTransfer | null;
  history?: TeamAuditEvent[];
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
  email?: EmailResult;
}

export interface InviteLookup {
  workshop: string;
  email: string;
  role: TeamRole;
  state: "open" | "expired" | "used" | "revoked";
}

export const ROLE_LABEL: Record<TeamRole, string> = { OWNER: "Owner", LEAD_TECH: "Lead technician", TECH: "Technician" };

/** Fetch a private file (schematic, DBC) with the session token. */
export async function apiBlob(path: string, token: string | null): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${CLOUD_API_URL}${path}`, {
      headers: { "X-Request-ID": newRequestId(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch {
    throw new ApiError(0, "Can't reach the RootCause cloud. Check your internet connection.");
  }
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = ((await res.json()) as { detail?: unknown }).detail;
    } catch {
      /* not JSON */
    }
    const fallback = `Couldn't open the file (HTTP ${res.status}).`;
    const message = res.status >= 500 ? serverErrorMessage(res.status, detail, fallback) : detailMessage(detail, fallback);
    throw new ApiError(res.status, message, detail);
  }
  return res.blob();
}

// --- Stored files -----------------------------------------------------------------

export interface Schematic {
  id: string;
  title: string;
  vehicle_profile: string | null;
  content_type: string | null;
  size_bytes: number | null;
  page_count: number | null;
  created_at: string | null;
  /** Pages counted against the quota when uploaded. */
  pages_charged?: number;
  /** Pages handed back if deleted now (same billing month only). */
  refundable_pages?: number;
  /** User id of the uploader (they, a lead tech or the owner may delete it). */
  uploaded_by?: string | null;
}

export interface SchematicDeleted {
  refunded_pages: number;
  pages_used: number;
  pages_limit: number;
}

// --- Accreditation (AASRA / MVIS), reviewed by a platform admin --------------------

export type AccreditationState =
  | "not_submitted"
  | "pending"
  | "approved"
  | "renewal_pending"
  | "rejected"
  | "expired"
  | "revoked";

export interface AccreditationEvidence {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface AccreditationRequest {
  id: string;
  kind: "WORKSHOP" | "TECHNICIAN";
  status: "PENDING" | "APPROVED" | "REJECTED" | "SUPERSEDED" | "EXPIRED" | "REVOKED";
  aasra_member_id: string | null;
  business_abn: string | null;
  national_police_check_dated: string | null;
  repairer_licence_renewed_at: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  decision_reason: string | null;
  expires_at: string | null;
  evidence: AccreditationEvidence[];
}

export interface AccreditationBlock {
  state: AccreditationState;
  /** Approved and still in date (may be expired if state says so). */
  current: AccreditationRequest | null;
  pending: AccreditationRequest | null;
  latest: AccreditationRequest | null;
}

export interface AccreditationOverview {
  technician: AccreditationBlock;
  workshop: AccreditationBlock;
  evidence_rules: { max_files: number; max_bytes: number; types: string[] };
  reminder_days: number[];
  dev_auto_approve: boolean;
}

export interface AdminAccreditation extends AccreditationRequest {
  workshop: string | null;
  tenant_id: string;
  subject_name: string | null;
  subject_email: string | null;
  paperwork_limit: string | null;
  events: { at: string | null; event: string; detail: Record<string, unknown> }[];
}

// --- Licensed procedures (platform admin) -------------------------------------------

export interface ProcedureCatalogue {
  feed_configured: boolean;
  feed_name: string | null;
  sources: {
    id: string;
    key: string;
    name: string;
    licence: string;
    licence_url: string | null;
    licensed_until: string | null;
    provider: string;
    active_procedures: number;
    updated_at: string | null;
  }[];
  recent: {
    id: string;
    source: string | null;
    source_ref: string;
    version: number;
    status: "ACTIVE" | "SUPERSEDED" | "WITHDRAWN";
    function_id: string;
    make: string;
    model: string;
    years: string;
    module: string;
    imported_at: string | null;
  }[];
}

export interface ProcedureImportResult {
  source: string;
  created: number;
  updated: number;
  unchanged: number;
  withdrawn: number;
  feed?: string;
}

export interface StoredDbc {
  id: string;
  name: string;
  vehicle_profile: string | null;
  size_bytes: number | null;
  message_count: number | null;
  sha256: string;
  created_at: string | null;
  /** Uploader's user id (they, a lead tech or the owner may delete it). */
  created_by?: string | null;
}
