// Key programming helpers shared with the daemon's rules (apps/edge-daemon/src/immo).

/** The daemon treats the sandbox virtual adapter as the sandbox dongle. */
export function canonicalDeviceId(adapterId: string): string {
  return adapterId === "virtual-sandbox-immo" || adapterId === "RC-DONGLE-SANDBOX" ? "RC-DONGLE-SANDBOX" : adapterId;
}

/** Which virtual adapter simulates which allow-listed profile. */
export function adapterMatchesProfile(adapterId: string, profileId: string): boolean {
  if (adapterId.startsWith("virtual-")) return adapterId.slice("virtual-".length) === profileId;
  return true; // Real dongles: the cloud and daemon check the device binding.
}

export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export const OPERATION_LABEL: Record<string, string> = {
  add_key_onboard: "Add a key (on-board learn)",
};

export const IMMO_SESSION_KEY = "rootcause.immoSession";
