// Classic Bluetooth (SPP) transport for cheap ELM327 clones. Android only; the dongle
// must be paired in Android's Bluetooth settings first.

import { BtClassic } from "../../modules/bt-classic";
import type { Transport } from "../obd/transport";

export interface PairedDongle {
  kind: "classic";
  name: string;
  address: string;
}

export async function listPaired(): Promise<PairedDongle[]> {
  const devices = await BtClassic.bondedDevices();
  return devices.map((d) => ({ kind: "classic", name: d.name, address: d.address }));
}

export async function connectClassic(dongle: PairedDongle): Promise<Transport> {
  await BtClassic.connect(dongle.address);
  return {
    label: dongle.name,
    write: (text) => BtClassic.write(text),
    onData(listener) {
      const sub = BtClassic.addListener("onData", (e) => listener(e.data));
      return () => sub.remove();
    },
    onDisconnect(listener) {
      const sub = BtClassic.addListener("onDisconnect", (e) => listener(e.reason));
      return () => sub.remove();
    },
    close: () => BtClassic.disconnect(),
  };
}
