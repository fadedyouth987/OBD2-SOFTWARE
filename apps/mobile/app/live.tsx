import { PIDS, type PidValue } from "@obd2/core/obd-pids";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useEffect, useRef, useState } from "react";
import { access } from "../src/plan/access";
import { readLive, readSupportedPids } from "../src/obd/scan";
import { useApp } from "../src/state";
import { AccessNote, Badge, Banner, Body, Button, Card, Row, Screen } from "../src/ui/kit";

const MAX_RECORDING_MS = 4 * 60 * 60 * 1000; // 4 hours per recording (D7)

export default function Live() {
  const { elm, me } = useApp();
  const [pids, setPids] = useState<number[] | null>(null);
  const [values, setValues] = useState<PidValue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [rows, setRows] = useState(0);
  const samples = useRef<{ t: number; v: PidValue[] }[]>([]);
  const started = useRef(0);
  const recordingRef = useRef(false);
  const recAccess = access("MOBILE_RECORDING", me);

  useEffect(() => {
    if (!elm) return;
    let stop = false;
    void (async () => {
      const supported = await readSupportedPids(elm);
      if (supported.status !== "ok") {
        setError(supported.status === "failed" ? supported.reason : "This car doesn't report live data.");
        return;
      }
      const wanted = PIDS.map((p) => p.pid).filter((p) => supported.value.includes(p));
      setPids(wanted);
      while (!stop) {
        const t0 = Date.now();
        const r = await readLive(elm, wanted);
        if (r.status === "failed") {
          setError(r.reason);
          stopRecording();
          return;
        }
        if (r.status === "ok") {
          setValues(r.value);
          setRate(Math.round(1000 / Math.max(1, Date.now() - t0)));
          if (recordingRef.current) {
            if (Date.now() - started.current > MAX_RECORDING_MS) stopRecording();
            else {
              samples.current.push({ t: Date.now(), v: r.value });
              setRows(samples.current.length);
            }
          }
        }
      }
    })();
    return () => {
      stop = true;
      deactivateKeepAwake("recording");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elm]);

  const startRecording = async () => {
    samples.current = [];
    started.current = Date.now();
    recordingRef.current = true;
    setRows(0);
    setRecording(true);
    await activateKeepAwakeAsync("recording");
  };

  function stopRecording() {
    recordingRef.current = false;
    setRecording(false);
    deactivateKeepAwake("recording");
  }

  const exportCsv = async () => {
    const names = PIDS.filter((p) => pids?.includes(p.pid));
    const header = ["time", ...names.map((p) => `${p.name} (${p.unit})`)].join(",");
    const lines = samples.current.map((s) => [new Date(s.t).toISOString(), ...names.map((p) => s.v.find((v) => v.pid === p.pid)?.value ?? "")].join(","));
    const file = new File(Paths.cache, `rootcause-live-${Date.now()}.csv`);
    file.write([header, ...lines].join("\n"));
    await Sharing.shareAsync(file.uri, { mimeType: "text/csv", dialogTitle: "Live data recording" });
  };

  if (!elm) return <Screen><Banner tone="warn" title="No dongle connected">Connect a dongle first.</Banner></Screen>;

  return (
    <Screen>
      {error ? <Banner tone="danger" title="Live data stopped">{error}</Banner> : null}
      <Card title="Recording">
        <AccessNote access={recAccess} />
        {recAccess.state === "available" ? (
          <>
            {recording ? <Badge tone="danger" label={`Recording · ${rows} samples`} /> : null}
            <Body muted>Keep the app open while recording; the screen stays on. Recordings stop after 4 hours.</Body>
            {recording ? (
              <Button label="Stop recording" onPress={stopRecording} />
            ) : (
              <Button label="Start recording" onPress={() => void startRecording()} disabled={!!error} />
            )}
            {!recording && rows > 0 ? <Button kind="ghost" label="Export CSV" onPress={() => void exportCsv()} /> : null}
          </>
        ) : null}
      </Card>
      <Card title={rate ? `Live values · ${rate} updates/s` : "Live values"}>
        {pids === null && !error ? <Body muted>Finding what this car reports…</Body> : null}
        {values.map((v) => (
          <Row key={v.pid} label={v.name} value={`${v.value} ${v.unit}`} />
        ))}
      </Card>
    </Screen>
  );
}
