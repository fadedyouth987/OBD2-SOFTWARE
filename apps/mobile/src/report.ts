// Customer report as HTML, printed to PDF on the phone (expo-print). The server's
// GET /jobs/{id}/report returns data, not a PDF. VINs are masked as on the web.

import { describeDtc } from "@obd2/core/dtc-library";
import type { Readiness } from "@obd2/core/obd-pids";
import { redactVin } from "@obd2/core/vin";
import type { Diagnosis } from "./api/client";
import type { CodeScan, ReadOutcome } from "./obd/scan";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function reportHtml(input: {
  scan: CodeScan;
  vin: ReadOutcome<string> | null;
  readiness: ReadOutcome<Readiness> | null;
  diagnosis: Diagnosis | null;
  server: Record<string, unknown> | null;
  now?: Date;
}): string {
  const { scan, vin, readiness, diagnosis } = input;
  const when = (input.now ?? new Date()).toLocaleString("en-AU");
  const rows =
    scan.stored.status === "ok"
      ? scan.stored.value.flatMap((m) => m.codes.map((c) => `<tr><td>${esc(c.code)}</td><td>${esc(m.module)}</td><td>${esc(describeDtc(c.code).description)}</td></tr>`))
      : [];
  const codes =
    scan.status !== "complete"
      ? "<p><strong>Scan incomplete.</strong> Some modules didn't answer, so codes may be missing.</p>"
      : rows.length
        ? `<table><tr><th>Code</th><th>Module</th><th>Meaning</th></tr>${rows.join("")}</table>`
        : "<p>No stored fault codes.</p>";
  const monitors =
    readiness?.status === "ok"
      ? `<p>Check-engine light: ${readiness.value.milOn ? "on" : "off"}</p><ul>${readiness.value.monitors
          .filter((m) => m.state !== "not supported")
          .map((m) => `<li>${esc(m.name)}: ${m.state === "complete" ? "complete" : "not ready"}</li>`)
          .join("")}</ul>`
      : "<p>Readiness not available.</p>";
  const ai = diagnosis?.summary ? `<h2>Diagnosis</h2><p>${esc(diagnosis.summary)}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,Roboto,sans-serif;color:#111;margin:32px}
h1{font-size:22px}h2{font-size:17px;margin-top:24px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left;font-size:13px}
.muted{color:#666;font-size:12px}
</style></head><body>
<h1>Vehicle health report</h1>
<p class="muted">${esc(when)} · VIN ${vin?.status === "ok" ? esc(redactVin(vin.value)) : "not reported"}</p>
<h2>Fault codes</h2>${codes}
<h2>Emissions readiness</h2>${monitors}
${ai}
<p class="muted">Prepared with RootCause. Read-only scan; nothing in the vehicle was changed.</p>
</body></html>`;
}
