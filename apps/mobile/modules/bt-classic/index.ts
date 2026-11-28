import { requireNativeModule, type EventSubscription } from "expo";

interface BtClassicNative {
  isEnabled(): Promise<boolean>;
  bondedDevices(): Promise<{ name: string; address: string }[]>;
  connect(address: string): Promise<void>;
  write(text: string): Promise<void>;
  disconnect(): Promise<void>;
  addListener(event: "onData", cb: (e: { data: string }) => void): EventSubscription;
  addListener(event: "onDisconnect", cb: (e: { reason: string }) => void): EventSubscription;
}

/** Classic Bluetooth (SPP) native module; Android only. */
export const BtClassic = requireNativeModule<BtClassicNative>("BtClassic");
