// Pair this phone with the workshop PC: scan the QR code on the PC's Devices
// page (Phone access → Pair a phone), check the PC's name and certificate,
// and the app asks the PC for this phone's own credential. The single-use code
// in the QR code is never stored.

import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Platform, StyleSheet, TextInput, View } from "react-native";
import { DaemonLink } from "../../modules/daemon-link";
import { APP_URL, APP_VERSION } from "../../src/config";
import { cleanDeviceName, groupFingerprint, parsePairingLink, type PairingLink } from "../../src/lan/link";
import { pairWithPc } from "../../src/lan/pair";
import { pcStore } from "../../src/lan/pc";
import { Banner, Body, Button, Card, Row, Screen, color } from "../../src/ui/kit";

const phoneModel = (Platform.constants as { Model?: string } | undefined)?.Model;

export default function PairWithPc() {
  const [permission, requestPermission] = useCameraPermissions();
  const [link, setLink] = useState<PairingLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [name, setName] = useState(cleanDeviceName(phoneModel));
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState<string | null>(null);
  const handled = useRef(false);

  const accept = (raw: string) => {
    const r = parsePairingLink(raw);
    if (r.ok) {
      setLink(r.link);
      setError(null);
    } else {
      setError(r.error);
      handled.current = false;
    }
  };

  const onScan = (e: BarcodeScanningResult) => {
    if (handled.current) return;
    handled.current = true;
    accept(e.data);
  };

  const pair = async () => {
    if (!link) return;
    setBusy(true);
    setError(null);
    try {
      const pc = await pairWithPc(link, {
        native: DaemonLink,
        origin: new URL(APP_URL).origin,
        deviceName: cleanDeviceName(name),
        clientVersion: APP_VERSION,
      });
      await pcStore.save(pc);
      setPaired(pc.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (paired) {
    return (
      <Screen>
        <Banner tone="ok" title={`Paired with ${paired}`}>
          This phone now connects to the PC over the workshop Wi-Fi. Clearing codes, service functions and key programming run
          on the PC&apos;s edge daemon, with its safety checks and audit log.
        </Banner>
        <Button label="Done" onPress={() => router.back()} />
      </Screen>
    );
  }

  if (link) {
    return (
      <Screen>
        <Card title="Check this is your PC">
          <Row label="PC" value={link.name} />
          <Row label="Address" value={`${link.host}:${link.port}`} />
          <Row label="Certificate starts" value={groupFingerprint(link.fingerprint)} />
          <Body muted>The PC&apos;s screen shows the same certificate start. The phone will only ever talk to that certificate.</Body>
        </Card>
        <Card title="Name for this phone">
          <Body muted>Shown in the PC&apos;s list of paired phones.</Body>
          <TextInput
            value={name}
            onChangeText={setName}
            maxLength={48}
            style={s.input}
            placeholderTextColor={color.muted}
            accessibilityLabel="Name for this phone"
          />
        </Card>
        {error ? <Banner tone="danger" title="Not paired">{error}</Banner> : null}
        <Button label="Pair" busy={busy} onPress={() => void pair()} />
        <Button
          kind="ghost"
          label="Scan a different code"
          onPress={() => {
            setLink(null);
            setError(null);
            handled.current = false;
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Card title="Scan the code on the PC">
        <Body muted>
          On the workshop PC, open RootCause → Devices → Phone access and choose Pair a phone. Codes work once, for 5 minutes. This
          phone must be on the same Wi-Fi as the PC.
        </Body>
        {permission?.granted ? (
          <View style={s.camera}>
            <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScan} />
          </View>
        ) : (
          <>
            <Body muted>The camera is used only to read the pairing code.</Body>
            <Button label="Allow the camera" onPress={() => void requestPermission()} />
          </>
        )}
      </Card>
      {error ? <Banner tone="warn" title="Can't use that code">{error}</Banner> : null}
      <Card title="Or paste the pairing link">
        <Body muted>On the PC, choose &quot;Can&apos;t scan? Show the pairing link&quot;, then copy it here.</Body>
        <TextInput
          value={pasted}
          onChangeText={setPasted}
          placeholder="rootcause://lan-pair?…"
          placeholderTextColor={color.muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={s.input}
          accessibilityLabel="Pairing link"
        />
        <Button kind="ghost" label="Use this link" disabled={!pasted.trim()} onPress={() => accept(pasted)} />
      </Card>
    </Screen>
  );
}

const s = StyleSheet.create({
  camera: { height: 280, borderRadius: 8, overflow: "hidden", backgroundColor: "#000" },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: color.text,
    backgroundColor: color.bg,
  },
});
