// Android Bluetooth permissions. Android 12+ asks for "Nearby devices"
// (BLUETOOTH_SCAN, declared neverForLocation, and BLUETOOTH_CONNECT); Android 8-11
// needs location permission to scan for Bluetooth devices.

import { PermissionsAndroid, Platform } from "react-native";

export async function ensureBluetoothPermission(): Promise<{ ok: boolean; message?: string }> {
  if (Platform.OS !== "android") return { ok: true };
  const api = typeof Platform.Version === "number" ? Platform.Version : Number.parseInt(String(Platform.Version), 10);
  const wanted =
    api >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(wanted);
  const denied = wanted.filter((p) => result[p] !== PermissionsAndroid.RESULTS.GRANTED);
  if (denied.length === 0) return { ok: true };
  return {
    ok: false,
    message:
      api >= 31
        ? "RootCause needs the Nearby devices permission to find and talk to your dongle. Allow it in Settings > Apps > RootCause > Permissions."
        : "Android needs location permission to scan for Bluetooth dongles on this phone version. RootCause doesn't use your location.",
  };
}
