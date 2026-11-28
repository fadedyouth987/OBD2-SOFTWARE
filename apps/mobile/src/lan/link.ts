// The pairing link in the QR code the workshop PC shows (Devices → Phone access →
// Pair a phone), made by the edge daemon (apps/edge-daemon/src/server/lan.rs):
//
//   rootcause://lan-pair?v=1&h=<ip>&p=<port>&fp=<sha256 of the cert>&t=<token>&id=rcd_<16 hex>&n=<name>
//
// It carries everything the phone needs to reach the PC and to know it reached
// the right one: the address, the certificate fingerprint to pin, and a
// single-use code that's good for 5 minutes. Anything that doesn't look exactly
// like that is refused here, before the phone opens any connection.

export interface PairingLink {
  /** IPv4 address, bracketed IPv6 address, or a .local name. */
  host: string;
  port: number;
  /** SHA-256 of the PC's certificate (DER), 64 lower-case hex digits. */
  fingerprint: string;
  /** Single-use pairing code. */
  token: string;
  daemonId: string;
  name: string;
}

export type ParsedLink = { ok: true; link: PairingLink } | { ok: false; error: string };

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^\[[0-9a-fA-F:.]{2,45}\]$/;
const LOCAL = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}\.local$/;

export function validHost(host: string): boolean {
  return IPV4.test(host) || (IPV6.test(host) && host.includes(":")) || LOCAL.test(host);
}

export function parsePairingLink(raw: string): ParsedLink {
  const text = raw.trim();
  const prefix = "rootcause://lan-pair?";
  if (!text.startsWith(prefix)) {
    return { ok: false, error: "That isn't a RootCause pairing code. Scan the code on the PC's Devices page (Phone access)." };
  }
  if (text.length > 512) return { ok: false, error: "That pairing link is too long." };
  const q = new URLSearchParams(text.slice(prefix.length));
  if (q.get("v") !== "1") {
    return { ok: false, error: "This pairing code is from a newer edge daemon. Update the RootCause app." };
  }
  const host = q.get("h") ?? "";
  const port = Number(q.get("p"));
  const fingerprint = q.get("fp") ?? "";
  const token = q.get("t") ?? "";
  const daemonId = q.get("id") ?? "";
  const name = (q.get("n") ?? "").trim();
  if (!validHost(host)) return { ok: false, error: "The pairing code has a bad PC address." };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "The pairing code has a bad port." };
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) return { ok: false, error: "The pairing code has a bad certificate fingerprint." };
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, error: "The pairing code is damaged. Make a new one on the PC." };
  if (!/^rcd_[0-9a-f]{16}$/.test(daemonId)) return { ok: false, error: "The pairing code has a bad PC id." };
  const safeName = /^[A-Za-z0-9 ._-]{1,48}$/.test(name) ? name : "Workshop PC";
  return { ok: true, link: { host, port, fingerprint, token, daemonId, name: safeName } };
}

/** wss URL for a host from a pairing link. */
export function daemonUrl(host: string, port: number): string {
  return `wss://${host}:${port}/`;
}

/** "ab12 cd34 ..." for reading aloud against the PC's screen. */
export function groupFingerprint(fp: string, groups = 4): string {
  return (fp.match(/.{1,4}/g) ?? []).slice(0, groups).join(" ");
}

/** A name for this phone on the PC's list, cleaned to what the daemon accepts. */
export function cleanDeviceName(raw: string | undefined | null): string {
  const s = (raw ?? "")
    .replace(/[^A-Za-z0-9 ._-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return s || "Android phone";
}
