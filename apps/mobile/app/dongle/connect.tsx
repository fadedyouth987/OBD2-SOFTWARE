import { router } from "expo-router";
import { useState } from "react";
import { Platform } from "react-native";
import { ElmError } from "../../src/obd/elm327";
import { Elm327Emulator } from "../../src/obd/emulator";
import type { Transport } from "../../src/obd/transport";
import { useApp } from "../../src/state";
import { connectBle, scanBle, type BleDongle } from "../../src/transports/ble";
import { connectClassic, listPaired, type PairedDongle } from "../../src/transports/classic";
import { ensureBluetoothPermission } from "../../src/transports/permissions";
import { Banner, Body, Button, Card, Screen } from "../../src/ui/kit";

type Dongle = BleDongle | PairedDongle;

export default function Connect() {
  const { attach } = useApp();
  const [found, setFound] = useState<Dongle[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setError(null);
    const perm = await ensureBluetoothPermission();
    if (!perm.ok) {
      setError(perm.message ?? "Bluetooth permission was refused.");
      return;
    }
    setSearching(true);
    setFound([]);
    try {
      if (Platform.OS === "android") {
        const paired = await listPaired().catch(() => [] as PairedDongle[]);
        setFound(paired);
      }
      await scanBle(8000, (d) => setFound((list) => (list.some((x) => x.kind === "ble" && x.id === d.id) ? list : [...list, d])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const use = async (key: string, open: () => Promise<Transport>) => {
    setBusy(key);
    setError(null);
    try {
      await attach(await open());
      router.back();
    } catch (e) {
      setError(e instanceof ElmError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <Card title="Find your dongle">
        <Body muted>Classic Bluetooth dongles must be paired in Android's Bluetooth settings first (the PIN is usually 1234 or 0000). Bluetooth LE dongles show up when you search.</Body>
        <Button label="Search" busy={searching} onPress={() => void search()} />
      </Card>
      {error ? <Banner tone="danger" title="Couldn't connect">{error}</Banner> : null}
      {found.map((d) => {
        const key = d.kind === "ble" ? d.id : d.address;
        return (
          <Card key={key} title={d.name}>
            <Body muted>{d.kind === "ble" ? "Bluetooth LE" : "Classic Bluetooth (paired)"}</Body>
            <Button label="Connect" busy={busy === key} disabled={!!busy && busy !== key} onPress={() => void use(key, () => (d.kind === "ble" ? connectBle(d) : connectClassic(d)))} />
          </Card>
        );
      })}
      <Card title="No dongle handy?">
        <Body muted>Try the app on a simulated car. Nothing is sent over Bluetooth.</Body>
        <Button kind="ghost" label="Use the demo car" busy={busy === "demo"} onPress={() => void use("demo", async () => new Elm327Emulator())} />
      </Card>
    </Screen>
  );
}
