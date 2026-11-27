import { describeDtc } from "@obd2/core/dtc-library";
import { redactVin } from "@obd2/core/vin";
import type { Readiness } from "@obd2/core/obd-pids";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useEffect, useState } from "react";
import { ApiError, type Diagnosis } from "../src/api/client";
import { reportHtml } from "../src/report";
import { access } from "../src/plan/access";
import { readFreezeFrame, readReadiness, readVin, scanCodes, type CodeScan, type FreezeFrame, type ModuleCodes, type ReadOutcome } from "../src/obd/scan";
import { useApp } from "../src/state";
import { AccessNote, Badge, Banner, Body, Button, Card, Row, Screen } from "../src/ui/kit";

function codeList(o: ReadOutcome<ModuleCodes[]>, empty: string) {
  if (o.status === "not supported") return <Body muted>Not supported by this car.</Body>;
  if (o.status === "failed") return <Banner tone="warn" title="Couldn't read">{o.reason}</Banner>;
  const all = o.value.flatMap((m) => m.codes.map((c) => ({ ...c, module: m.module })));
  if (all.length === 0) return <Body muted>{empty}</Body>;
  return all.map((c) => (
    <Row key={`${c.module}-${c.code}`} label={`${c.code} · ${c.module}`} value={describeDtc(c.code).description} />
  ));
}

export default function Scan() {
  const { elm, api, me, refreshMe } = useApp();
  const [running, setRunning] = useState(false);
  const [scan, setScan] = useState<CodeScan | null>(null);
  const [vin, setVin] = useState<ReadOutcome<string> | null>(null);
  const [ready, setReady] = useState<ReadOutcome<Readiness> | null>(null);
  const [ff, setFf] = useState<ReadOutcome<FreezeFrame> | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);

  const run = async () => {
    if (!elm) return;
    setRunning(true);
    setDiag(null);
    setJobId(null);
    setSaveError(null);
    const codes = await scanCodes(elm);
    setScan(codes);
    setVin(await readVin(elm));
    setReady(await readReadiness(elm));
    setFf(await readFreezeFrame(elm, [0x0c, 0x0d, 0x05, 0x04, 0x06, 0x07, 0x0b]));
    setRunning(false);
  };

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const codes = scan?.stored.status === "ok" ? scan.stored.value.flatMap((m) => m.codes.map((c) => c.code)) : [];

  const save = async (): Promise<string | null> => {
    if (!scan || scan.stored.status !== "ok") return null;
    setSaveError(null);
    try {
      const job = jobId ? { id: jobId } : await api.startJob({ vin: vin?.status === "ok" ? vin.value : null, protocol: elm?.info?.protocol ?? null });
      await api.saveCodes(job.id, scan.stored.value);
      setJobId(job.id);
      return job.id;
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : String(e));
      return null;
    }
  };

  const aiAccess = access("AI_DIAGNOSIS", me);
  const diagnose = async () => {
    setDiagBusy(true);
    setDiagError(null);
    try {
      const id = await save();
      if (!id) return;
      setDiag(await api.diagnose(id, codes));
      await refreshMe();
    } catch (e) {
      setDiagError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setDiagBusy(false);
    }
  };

  const share = async () => {
    const id = await save();
    if (!id) return;
    const data = await api.report(id).catch(() => null);
    const { uri } = await Print.printToFileAsync({ html: reportHtml({ scan: scan!, vin, readiness: ready, diagnosis: diag, server: data }) });
    await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: "Customer report" });
  };

  if (!elm) return <Screen><Banner tone="warn" title="No dongle connected">Connect a dongle first.</Banner></Screen>;

  return (
    <Screen>
      {running ? <Banner tone="info" title="Scanning…">Keep the ignition on.</Banner> : null}
      {scan ? (
        <Card title="Engine codes">
          {scan.status === "complete" ? <Badge tone="ok" label="Scan complete" /> : <Badge tone="danger" label="Scan incomplete" />}
          {scan.status === "incomplete" ? (
            <Banner tone="warn" title="Scan incomplete">Some modules didn't answer, so this list may be missing codes. Check the dongle and ignition, then scan again.</Banner>
          ) : null}
          <Body>Stored</Body>
          {codeList(scan.stored, "No stored codes.")}
          <Body>Pending</Body>
          {codeList(scan.pending, "No pending codes.")}
          <Body>Permanent</Body>
          {codeList(scan.permanent, "No permanent codes.")}
        </Card>
      ) : null}
      {vin ? (
        <Card title="Vehicle">
          <Row label="VIN" value={vin.status === "ok" ? redactVin(vin.value) : vin.status === "failed" ? "Couldn't read" : "Not reported"} />
        </Card>
      ) : null}
      {ready ? (
        <Card title="Readiness monitors">
          {ready.status !== "ok" ? (
            <Body muted>{ready.status === "failed" ? `Couldn't read: ${ready.reason}` : "Not supported by this car."}</Body>
          ) : (
            <>
              <Row label="Check-engine light" value={ready.value.milOn ? "On" : "Off"} tone={ready.value.milOn ? "danger" : "ok"} />
              {ready.value.monitors.filter((m) => m.state !== "not supported").map((m) => (
                <Row key={m.name} label={m.name} value={m.state === "complete" ? "Complete" : "Not ready"} tone={m.state === "complete" ? "ok" : "warn"} />
              ))}
            </>
          )}
        </Card>
      ) : null}
      {ff?.status === "ok" ? (
        <Card title={`Freeze frame${ff.value.code ? ` (${ff.value.code})` : ""}`}>
          {ff.value.values.map((v) => <Row key={v.pid} label={v.name} value={`${v.value} ${v.unit}`} />)}
        </Card>
      ) : null}
      {scan?.status === "complete" ? (
        <Card title="AI diagnosis">
          <AccessNote access={aiAccess} />
          {aiAccess.state === "available" && aiAccess.quota ? <Body muted>{`${aiAccess.quota.left} of ${aiAccess.quota.limit} left this month.`}</Body> : null}
          {diagError ? <Banner tone="danger" title="Diagnosis failed">{diagError}</Banner> : null}
          {diag ? (
            <>
              {diag.summary ? <Body>{diag.summary}</Body> : null}
              {(diag.likely_causes ?? []).map((c) => <Row key={c.title} label={c.title} value={c.confidence ?? ""} />)}
              {(diag.next_checks ?? []).map((n) => <Body key={n} muted>{`• ${n}`}</Body>)}
            </>
          ) : (
            <Button label="Diagnose" busy={diagBusy} disabled={aiAccess.state !== "available" || codes.length === 0} onPress={() => void diagnose()} />
          )}
        </Card>
      ) : null}
      {saveError ? <Banner tone="danger" title="Couldn't save the job">{saveError}</Banner> : null}
      {scan?.status === "complete" ? <Button kind="ghost" label="Share customer report (PDF)" onPress={() => void share()} /> : null}
      <Card title="Clear codes">
        <AccessNote access={access("UDS_ACTIVE", me)} />
      </Card>
      <Button kind="ghost" label="Scan again" busy={running} onPress={() => void run()} />
    </Screen>
  );
}
