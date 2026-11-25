"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActiveModeNotice } from "@/components/edge/ActiveModeNotice";
import { SafetyConfirmModal } from "@/components/safety/SafetyConfirmModal";
import { tierFor, useGatedRunner, useLiveReadings, type GatedResult, type GatedStep } from "@/components/safety/useGated";
import { useScanTargets } from "@/components/job/useScanTargets";
import { Badge, Banner, Button, Card, EmptyState, Mono, Spinner, type Tone } from "@/components/ui";
import { useEdge } from "@/context/edge";
import { useJob } from "@/context/job";
import { hexId, udsStatusWords } from "@/lib/diag";
import { describeDtc } from "@/lib/dtc-library";
import { formatTime } from "@/lib/format";
import { scanModule, type ModuleResult, type ScanTarget } from "@/lib/scan";
import type { JobDtc } from "@/lib/api";

const STATUS_TONE: Record<string, Tone> = {
  confirmed: "danger",
  stored: "danger",
  permanent: "warn",
  pending: "warn",
  history: "neutral",
};

const OUTCOME: Record<ModuleResult["outcome"], [Tone, string]> = {
  codes: ["danger", "Codes"],
  clear: ["ok", "No codes"],
  refused: ["warn", "Refused"],
  no_response: ["neutral", "No response"],
  error: ["danger", "Error"],
};

export function DtcCard() {
  const { job, update, scan, setScan, setCleared } = useJob();
  const edge = useEdge();
  const { targets, unscannable } = useScanTargets(job);
  const live = useLiveReadings();
  const { run } = useGatedRunner(job);
  const params = useSearchParams();
  const [scanning, setScanning] = useState<{ done: number; total: number; current: string } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [clearResults, setClearResults] = useState<GatedResult[] | null>(null);
  const autoScanned = useRef(false);

  const connected = edge.ready && edge.link?.state === "CONNECTED";
  const open = job?.status === "OPEN";

  const runScan = useCallback(
    async (list: ScanTarget[] = targets) => {
      if (!job) return [];
      setScanError(null);
      setSaveError(null);
      const results: ModuleResult[] = [];
      for (let i = 0; i < list.length; i += 1) {
        setScanning({ done: i, total: list.length, current: list[i].module });
        results.push(await scanModule((r) => edge.diag(r), list[i]));
      }
      setScanning(null);
      setScan({ at: Date.now(), results });
      if (results.every((r) => r.outcome === "no_response" || r.outcome === "error")) {
        setScanError("No module answered. Check the ignition is on and the adapter is seated, then scan again.");
      }
      const dtcs: JobDtc[] = results.flatMap((r) =>
        r.dtcs.map((d) => ({
          code: d.code,
          module: d.module,
          status: d.status,
          source: d.source,
          description: describeDtc(d.code).description.slice(0, 200),
          status_byte: d.statusByte,
        })),
      );
      if (job.status === "OPEN") {
        try {
          await update({ dtcs });
        } catch (e) {
          setSaveError(e instanceof Error ? e.message : "Couldn't save the codes to the job.");
        }
      }
      return results;
    },
    [job, targets, edge, setScan, update],
  );

  useEffect(() => {
    if (autoScanned.current || !connected || !open || !targets.length) return;
    if (params.get("scan") !== "1") return;
    autoScanned.current = true;
    void runScan();
  }, [connected, open, targets, params, runScan]);

  const clearSteps: GatedStep[] = useMemo(() => {
    const steps: GatedStep[] = [];
    const withCodes = (scan?.results ?? []).filter((r) => r.outcome === "codes");
    for (const r of withCodes) {
      const t = r.target;
      if (t.obd) steps.push({ label: `Clear emissions codes (OBD 04) on ${t.module}`, module: t.module, tx: t.tx, rx: t.rx, protocol: "OBD", payloadHex: "04" });
      if (t.protocol === "UDS") steps.push({ label: `Clear codes (UDS 14) on ${t.module}`, module: t.module, tx: t.tx, rx: t.rx, protocol: "UDS", payloadHex: "14FFFFFF" });
      if (t.protocol === "KWP2000") steps.push({ label: `Clear codes (KWP 14) on ${t.module}`, module: t.module, tx: t.tx, rx: t.rx, protocol: "KWP2000", payloadHex: "14FF00" });
    }
    return steps;
  }, [scan]);

  const clearTier = clearSteps.some((s) => tierFor(s) === "B") ? "B" : "A";
  const activeMode = edge.link?.safetyMode === "ACTIVE_CONFIRMED";
  const modules = [...new Set(clearSteps.map((s) => s.module))];

  const doClear = async () => {
    setClearBusy(true);
    setClearError(null);
    const results = await run(
      clearSteps,
      `Clear diagnostic trouble codes on ${modules.join(", ")}. Freeze-frame data and readiness monitors reset.`,
    );
    setClearResults(results);
    setClearBusy(false);
    const failed = results.filter((r) => !r.ok);
    if (failed.length || results.length < clearSteps.length) {
      setClearError(failed.map((f) => `${f.step.module}: ${f.message}`).join(" "));
      if (!results.some((r) => r.ok)) return;
    }
    setClearOpen(false);
    // Verify by reading the codes back.
    const after = await runScan(targets);
    const remaining = after.flatMap((r) => r.dtcs).filter((d) => d.status !== "history");
    setCleared(failed.length === 0 && remaining.length === 0);
  };

  const storedDtcs = job?.dtcs ?? [];
  const showResults = scan?.results ?? null;

  return (
    <Card
      title="Diagnostic trouble codes"
      subtitle={
        scan
          ? `Scanned ${formatTime(scan.at)} · ${scan.results.length} module${scan.results.length === 1 ? "" : "s"}`
          : storedDtcs.length
            ? "Saved on this job"
            : "Scan every module for stored, pending and permanent codes."
      }
      actions={
        open ? (
          <>
            <Button
              variant="blue"
              size="sm"
              busy={!!scanning}
              disabled={!connected || !targets.length}
              onClick={() => void runScan()}
            >
              {scan ? "Scan again" : "Scan all modules"}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={!connected || !activeMode || !clearSteps.length || !!scanning}
              onClick={() => {
                setClearError(null);
                setClearResults(null);
                setClearOpen(true);
              }}
              title={!activeMode ? "Needs Active mode" : !clearSteps.length ? "Scan first; only modules with codes are cleared" : undefined}
            >
              Clear codes
            </Button>
          </>
        ) : null
      }
    >
      <div className="space-y-4">
        {open && connected && clearSteps.length ? <ActiveModeNotice what="Clearing codes" /> : null}
        {unscannable ? (
          <Banner tone="info">This virtual vehicle is on a K-line bus, which the app can&apos;t scan yet. Use OBD live data instead.</Banner>
        ) : null}
        {scanning ? (
          <div className="rounded-lg border border-line bg-raised p-3">
            <Spinner label={`Scanning ${scanning.current} (${scanning.done + 1} of ${scanning.total})…`} />
          </div>
        ) : null}
        {scanError ? <Banner tone="warn">{scanError}</Banner> : null}
        {saveError ? <Banner tone="danger" title="Codes read but not saved">{saveError}</Banner> : null}
        {clearResults && !clearOpen ? (
          clearResults.every((r) => r.ok) && clearResults.length === clearSteps.length ? (
            <Banner tone="ok" title="Codes cleared">
              Every module confirmed the clear. The scan above shows what&apos;s left (codes can return if the fault is still there).
            </Banner>
          ) : (
            <Banner tone="danger" title="Not every module cleared">
              {clearResults.filter((r) => !r.ok).map((r) => `${r.step.module}: ${r.message}`).join(" ") || clearError}
            </Banner>
          )
        ) : null}

        {showResults ? (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {showResults.map((r) => {
              const [tone, text] = OUTCOME[r.outcome];
              return (
                <li key={`${r.target.module}-${r.target.tx}-${r.target.rx}`} className="rounded-lg border border-line bg-raised p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{r.target.module}</span>
                    <Badge tone={tone}>{r.outcome === "codes" ? `${r.dtcs.length} code${r.dtcs.length === 1 ? "" : "s"}` : text}</Badge>
                  </div>
                  <p className="mt-0.5 font-mono text-[11px] text-faint">
                    {hexId(r.target.tx)} → {hexId(r.target.rx)} · {[r.target.obd ? "OBD" : null, r.target.protocol].filter(Boolean).join(" + ")}
                  </p>
                  {r.outcome !== "codes" && r.outcome !== "clear" ? <p className="mt-1 text-xs text-muted">{r.message}</p> : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {storedDtcs.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-semibold">Code</th>
                  <th className="py-2 pr-3 font-semibold">Description</th>
                  <th className="py-2 pr-3 font-semibold">Module</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 font-semibold">Read by</th>
                </tr>
              </thead>
              <tbody>
                {storedDtcs.map((d) => {
                  const info = describeDtc(d.code);
                  return (
                    <tr key={`${d.module}-${d.code}`} className="border-b border-line last:border-0 align-top">
                      <td className="py-2 pr-3">
                        <Mono className="font-bold">{d.code}</Mono>
                      </td>
                      <td className="py-2 pr-3">
                        <span className={info.kind === "generic" ? "" : "text-muted"}>{info.description}</span>
                        {d.status_byte !== null ? (
                          <span className="mt-0.5 block text-[11px] text-faint">{udsStatusWords(d.status_byte).join(", ")}</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">{d.module || "—"}</td>
                      <td className="py-2 pr-3">
                        <Badge tone={STATUS_TONE[d.status] ?? "neutral"}>{d.status || "—"}</Badge>
                      </td>
                      <td className="py-2 text-xs text-muted">{d.source}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : !scanning ? (
          <EmptyState title={scan ? "No codes stored" : "No codes recorded yet"}>
            {scan
              ? "Every module that answered reported no stored, pending or permanent codes."
              : connected
                ? "Run a scan to read every module."
                : open
                  ? "Connect the vehicle, then scan."
                  : "This job was closed without any codes recorded."}
          </EmptyState>
        ) : null}
      </div>

      <SafetyConfirmModal
        open={clearOpen}
        action="Clear diagnostic trouble codes"
        target={modules.map((m) => {
          const s = clearSteps.find((x) => x.module === m)!;
          return `${m} (${hexId(s.tx)})`;
        }).join(", ")}
        consequence="Erases stored codes and freeze-frame data, and resets readiness monitors. The check-engine light goes out until a fault is detected again. Write the codes down first (they're saved on this job)."
        tier={clearTier}
        checklist={["Codes are recorded on this job", "Ignition on, engine off"]}
        live={live}
        busy={clearBusy}
        error={clearError}
        confirmLabel={`Hold to clear ${modules.length} module${modules.length === 1 ? "" : "s"}`}
        onCancel={() => setClearOpen(false)}
        onConfirm={() => void doClear()}
      />
    </Card>
  );
}
