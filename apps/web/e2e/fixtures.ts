// Stand-in cloud API for end-to-end tests: realistic responses shaped from
// src/lib/api.ts, served by intercepting the API origin. The vehicle side uses
// the built-in browser demo car, so no daemon, database or hardware is needed.
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

export type ApiMode = "ok" | "server_error" | "offline" | "empty_jobs";

const now = new Date().toISOString();
const entitlements = {
  tier: "WORKSHOP", stored_tier: "WORKSHOP", billing_status: "active", immo_entitled: false, lease_version: 1,
  ai_diagnoses: 200, schematic_pages: 500, seats: 5, sites: 2, features: ["J2534", "UDS_ACTIVE", "CAN_RE_PRO"],
  billing_grace_until: null, trial_ends_at: null, trial_used: true,
};
export const me = {
  user: { id: "u1", email: "tech@example.com.au", display_name: "Sam Tech", last_login_at: now },
  workspace: { tenant_id: "t1", name: "Example Motors", role: "OWNER", aasra_verified: false, permissions: ["MANAGE_ALL_JOBS"] },
  platform_admin: false,
  workspaces: [{ tenant_id: "t1", name: "Example Motors", role: "OWNER", tier: "WORKSHOP" }],
  entitlements,
  usage: { ai_diagnoses_used: 37, schematic_pages_used: 120, quota_period_start: now, quota_timezone: "Australia/Adelaide" },
  immo_feature_enabled: false, dev_login_enabled: false,
  ai: { model_configured: true, model_label: "Example model" },
};
export const job = {
  id: "j1", edge_session_id: "s1", status: "OPEN", vehicle_label: "2008 BMW 320i (E90)", vehicle_profile: "bmw_e90_n46",
  vin_redacted: "WBAPH5C5•••••3456", odometer_km: 141880, protocol: "AUTO", adapter_id: "browser-demo", adapter_kind: "BROWSER_DEMO",
  daemon_version: "0.0.0", lease_tier: "COMMUNITY", customer_ref: "RO-1042", complaint: "Rough idle, MIL on",
  vehicle_make: "BMW", vehicle_model: "320i", model_year: 2008,
  dtcs: [
    { code: "P0301", module: "DME", status: "ACTIVE", source: "UDS", description: "Cylinder 1 misfire detected", status_byte: 9 },
    { code: "P0171", module: "DME", status: "STORED", source: "UDS", description: "System too lean (bank 1)", status_byte: 8 },
  ],
  alerts: [
    { rule_id: "audit.odometer_mismatch", severity: "RED", title: "Odometer mismatch between KOMBI and DME", recommended_test: "Compare the cluster with service records.", evidence_json: { kombi_km: 84210, dme_km: 141880 } },
  ],
  diagnosis: {
    dtcs: ["P0301", "P0171"], vehicle_profile: "bmw_e90_n46", at: now,
    result: {
      session_id: "s1", vehicle: "BMW 320i", mode: "LLM", analysis: "llm", analysis_label: "Example model", quota_charged: true,
      summary: "Lean condition plus a cylinder 1 misfire points to a vacuum leak.",
      shared_circuit_nodes: ["node:dme_x60001"],
      matched_cases: [{ case_id: "case-0012", wmi_vds: "WBAPH5", engine_family: "N46", dtcs: ["P0171", "P0301"], symptom_summary: "Rough idle cold", verified_fix: "Replaced crankcase vent valve" }],
      ranked_causes: [
        { dtc: "P0171", confidence_band: "HIGH", cited_nodes: ["node:ccv"], cited_case_ids: ["case-0012"], hypothesis: "Failed crankcase ventilation valve", multimeter_test: "Smoke test intake", guided_steps: [{ step: "1", action: "Smoke test the intake" }] },
        { dtc: "P0301", confidence_band: "MEDIUM", cited_nodes: ["node:coil1"], cited_case_ids: [], hypothesis: "Ignition coil 1 weak", multimeter_test: "Swap coils 1 and 2", guided_steps: [] },
      ],
    },
  },
  closeout: null, started_at: now, ended_at: null, updated_at: now, user_id: "u1", technician_name: "Sam Tech", can_edit: true,
};
const platform = {
  profile: "bmw_e90_n46", make: "BMW", model: "3 Series (E90)", engine: "N46", protocols: ["BMW_DCAN"],
  modules: [{ id: "DME", bus: "PT-CAN", tx: "0x612", rx: "0x612" }], shared_nodes: [], common_dtcs: {},
};

function route(method: string, path: string, mode: ApiMode): unknown {
  const p = path.split("?")[0];
  if (p === "/api/v1/auth/me") return me;
  if (p === "/api/v1/auth/config") return { password_enabled: true, oidc: { enabled: false, provider_name: null, logout_url: null }, dev_login: false };
  if (p === "/api/v1/jobs" && method === "GET") return mode === "empty_jobs" ? { jobs: [], open: 0, closed: 0 } : { jobs: [job], open: 1, closed: 0 };
  // Updates return the full job, like the real API.
  if (p === "/api/v1/jobs/j1") return job;
  if (p.startsWith("/api/v1/jobs/j1/")) return method === "GET" ? job : { ...job, status: "OPEN" };
  if (p === "/api/v1/vehicles") return { platforms: [platform], vehicles: [platform] };
  if (p.startsWith("/api/v1/vehicles/") && p.endsWith("/services")) return { adapter_id: null, source: "none", note: "", modules: platform.modules, functions: [] };
  if (p === "/api/v1/service-functions") return { adapter_id: null, source: "none", note: "", functions: [] };
  if (p === "/api/v1/dbc") return { items: [] };
  if (p === "/api/v1/schematics") return { items: [] };
  if (p === "/api/v1/sessions/sync") return { status: "accepted" };
  if (method !== "GET") return {};
  return null;
}

const fakeJwt = () => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 36_000 })).toString("base64url")}.sig`;

export async function useStandIns(context: BrowserContext, opts: { mode?: ApiMode; theme?: "night" | "daylight"; signedIn?: boolean } = {}) {
  const mode = opts.mode ?? "ok";
  await context.addInitScript(
    ([token, theme, signedIn]) => {
      if (signedIn) localStorage.setItem("rootcause.session", token);
      localStorage.setItem("rootcause.edgeMode", "browser-sim");
      localStorage.setItem("rootcause.theme", theme);
    },
    [fakeJwt(), opts.theme ?? "night", opts.signedIn ?? true] as const,
  );
  await context.route(/^https?:\/\/(127\.0\.0\.1|localhost):8000\//, async (r) => {
    const url = new URL(r.request().url());
    if (mode === "offline") return r.abort("connectionrefused");
    const isAccount = url.pathname === "/api/v1/auth/me" || url.pathname === "/api/v1/auth/config";
    if (mode === "server_error" && !isAccount) {
      return r.fulfill({ status: 500, contentType: "application/json", body: '{"detail":"Internal Server Error"}' });
    }
    const data = route(r.request().method(), url.pathname + url.search, mode);
    if (data === null) return r.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"Not found"}' });
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
}

/** Connects the browser demo car from the Devices page (stays connected for in-app navigation). */
export async function connectDemoCar(page: Page) {
  await page.goto("/devices");
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  await expect(page.locator('header a[href="/devices"]')).toContainText("Browser demo car");
}

export const test = base;
export { expect };
