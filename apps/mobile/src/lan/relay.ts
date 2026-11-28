// Carries the web app's edge-daemon connection between the web view and the
// native TLS link (the web side is apps/web/src/lib/native-daemon.ts). The web
// app speaks the normal daemon protocol (Hello with the technician's cloud
// pairing token, leases, safety confirmations); this only moves frames, adding
// the PC's pinned certificate and this phone's credential underneath.

import { daemonUrl } from "./link";
import type { CloseReason, DaemonLinkLike } from "./native";
import type { PairedPc } from "./store";

export type RelayEvent =
  | { id: string; kind: "open" }
  | { id: string; kind: "message"; text: string }
  | { id: string; kind: "close"; wasOpen: boolean; reason: CloseReason; detail?: string };

/** Script that hands events to the web app's receiver. */
export function deliverScript(events: RelayEvent[]): string {
  return `(function(){var r=window.RootCauseNativeDaemon;if(r&&r.deliver){r.deliver(${JSON.stringify(events)});}})();true;`;
}

export class DaemonRelay {
  private open = new Set<string>();
  private queue: RelayEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private unsub: () => void;

  constructor(
    private readonly deps: {
      native: DaemonLinkLike;
      inject(script: string): void;
      pc(): PairedPc | null | undefined;
      origin: string;
      /** Batch window for frames from the PC (ms). */
      batchMs?: number;
    },
  ) {
    this.unsub = deps.native.subscribe({
      onOpen: (e) => {
        if (this.open.has(e.id)) this.push({ id: e.id, kind: "open" });
      },
      onMessage: (e) => {
        if (this.open.has(e.id)) this.push({ id: e.id, kind: "message", text: e.text });
      },
      onClose: (e) => {
        if (!this.open.delete(e.id)) return;
        this.push({ id: e.id, kind: "close", wasOpen: e.wasOpen, reason: e.reason, detail: e.detail });
      },
    });
  }

  /** The web app asked to connect. */
  openConnection(id: string): void {
    const pc = this.deps.pc();
    if (!pc) {
      this.push({ id, kind: "close", wasOpen: false, reason: "unpaired" });
      return;
    }
    this.open.add(id);
    this.deps.native
      .connect(id, daemonUrl(pc.host, pc.port), pc.fingerprint, `Bearer ${pc.deviceId}.${pc.deviceSecret}`, this.deps.origin)
      .catch((e: unknown) => {
        if (!this.open.delete(id)) return;
        this.push({ id, kind: "close", wasOpen: false, reason: "unreachable", detail: e instanceof Error ? e.message : String(e) });
      });
  }

  send(id: string, text: string): void {
    if (this.open.has(id)) void this.deps.native.send(id, text);
  }

  /** The web app closed its side. */
  closeConnection(id: string): void {
    if (this.open.delete(id)) void this.deps.native.close(id);
  }

  /** Drops every connection (PC forgotten or changed, web view reloaded). */
  closeAll(reason: CloseReason | null): void {
    for (const id of [...this.open]) {
      this.open.delete(id);
      void this.deps.native.close(id);
      if (reason) this.push({ id, kind: "close", wasOpen: false, reason });
    }
    if (!reason) this.queue = [];
  }

  dispose(): void {
    this.closeAll(null);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.unsub();
  }

  private push(ev: RelayEvent): void {
    this.queue.push(ev);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.deps.batchMs ?? 16);
  }

  flush(): void {
    this.flushTimer = null;
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    this.deps.inject(deliverScript(batch));
  }
}
