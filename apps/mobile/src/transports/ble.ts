// Bluetooth LE transport (OBDLink CX/MX+, Vgate iCar Pro BLE and BLE ELM327 clones).
// Dongles differ in their GATT layout, so the serial pair is found by discovery: the
// first vendor service with a notify characteristic and a write characteristic.

import { BleManager, type Characteristic, type Device, type Subscription } from "react-native-ble-plx";
import type { Transport } from "../obd/transport";

const STANDARD_SERVICES = new Set(["1800", "1801", "180a", "180f"]);
const short = (uuid: string) => (uuid.length > 8 ? uuid.slice(4, 8) : uuid).toLowerCase();

let manager: BleManager | null = null;
export const ble = () => (manager ??= new BleManager());

export interface BleDongle {
  kind: "ble";
  id: string;
  name: string;
}

/** Scan for nearby BLE devices for `ms` milliseconds; named devices only. */
export function scanBle(ms: number, onFound: (d: BleDongle) => void): Promise<void> {
  const seen = new Set<string>();
  return new Promise((resolve, reject) => {
    ble().startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        ble().stopDeviceScan();
        reject(new Error(error.message));
        return;
      }
      if (!device || seen.has(device.id) || !(device.name ?? device.localName)) return;
      seen.add(device.id);
      onFound({ kind: "ble", id: device.id, name: (device.name ?? device.localName)! });
    });
    setTimeout(() => {
      ble().stopDeviceScan();
      resolve();
    }, ms);
  });
}

async function findSerialPair(device: Device): Promise<{ notify: Characteristic; write: Characteristic }> {
  for (const service of await device.services()) {
    if (STANDARD_SERVICES.has(short(service.uuid))) continue;
    const chars = await service.characteristics();
    const notify = chars.find((c) => c.isNotifiable || c.isIndicatable);
    const write = chars.find((c) => c.isWritableWithoutResponse || c.isWritableWithResponse);
    if (notify && write) return { notify, write };
  }
  throw new Error("This Bluetooth device doesn't look like an OBD dongle.");
}

// Latin-1 <-> base64 without relying on platform globals.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function toBase64(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 3) {
    const [a, b, c] = [text.charCodeAt(i), text.charCodeAt(i + 1), text.charCodeAt(i + 2)];
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < text.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < text.length ? B64[n & 63] : "=");
  }
  return out;
}
export function fromBase64(b64: string): string {
  let out = "";
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
    out += String.fromCharCode((n >> 16) & 255);
    if (clean[i + 2] !== undefined) out += String.fromCharCode((n >> 8) & 255);
    if (clean[i + 3] !== undefined) out += String.fromCharCode(n & 255);
  }
  return out;
}

export async function connectBle(dongle: BleDongle): Promise<Transport> {
  const device = await ble().connectToDevice(dongle.id, { timeout: 10_000 });
  await device.discoverAllServicesAndCharacteristics();
  const { notify, write } = await findSerialPair(device);
  const dataListeners = new Set<(c: string) => void>();
  const dropListeners = new Set<(w: string) => void>();
  const monitor: Subscription = notify.monitor((error, c) => {
    if (error || !c?.value) return;
    const text = fromBase64(c.value);
    dataListeners.forEach((l) => l(text));
  });
  const dropSub = device.onDisconnected(() => dropListeners.forEach((l) => l("The dongle disconnected.")));
  const withResponse = !write.isWritableWithoutResponse;
  return {
    label: dongle.name,
    async write(text) {
      // BLE writes are small; send in 20-byte pieces (the minimum MTU).
      for (let i = 0; i < text.length; i += 20) {
        const piece = toBase64(text.slice(i, i + 20));
        if (withResponse) await write.writeWithResponse(piece);
        else await write.writeWithoutResponse(piece);
      }
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onDisconnect(listener) {
      dropListeners.add(listener);
      return () => dropListeners.delete(listener);
    },
    async close() {
      monitor.remove();
      dropSub.remove();
      await device.cancelConnection().catch(() => undefined);
    },
  };
}
