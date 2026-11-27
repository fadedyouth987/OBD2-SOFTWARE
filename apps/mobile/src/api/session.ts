// Keeps the sign-in token in the Android Keystore (expo-secure-store), never in
// plain storage.

import * as SecureStore from "expo-secure-store";

const KEY = "rootcause.session";

export async function loadToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
