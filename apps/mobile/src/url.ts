// Release builds talk to RootCause over https only; dev builds may use this machine.

export function checkUrl(raw: string, dev: boolean): string {
  if (!raw) throw new Error("This build has no RootCause address set (EXPO_PUBLIC_APP_URL / EXPO_PUBLIC_API_URL).");
  const url = new URL(raw);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "10.0.2.2";
  if (url.protocol !== "https:" && !(dev && local && url.protocol === "http:")) {
    throw new Error(`RootCause address must be https: ${raw}`);
  }
  return url.origin;
}
