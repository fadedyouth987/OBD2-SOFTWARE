// The app's one PcStore, on expo-secure-store (Android Keystore), and the native
// link if this build has it.

import { requireOptionalNativeModule } from "expo";
import * as SecureStore from "expo-secure-store";
import { PcStore } from "./store";

export const pcStore = new PcStore({
  getItemAsync: (k) => SecureStore.getItemAsync(k),
  setItemAsync: (k, v) => SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  deleteItemAsync: (k) => SecureStore.deleteItemAsync(k),
});

/** False in builds made before the daemon link existed (the web app then hides phone pairing). */
export const hasDaemonLink = requireOptionalNativeModule("DaemonLink") != null;
