// The shape of the native link (modules/daemon-link) the pairing flow and relay
// use, so both run under jest with a fake.

/** Why a connection ended, as the web app's native-daemon transport expects. */
export type CloseReason = "unreachable" | "identity" | "revoked" | "rejected" | "closed" | "unpaired";

export interface LinkEvents {
  onOpen(e: { id: string }): void;
  onMessage(e: { id: string; text: string }): void;
  onClose(e: { id: string; wasOpen: boolean; reason: CloseReason; detail?: string }): void;
}

export interface DaemonLinkLike {
  /** Opens wss to `url`, trusting only the certificate whose SHA-256 is `pin`. */
  connect(id: string, url: string, pin: string, authorization: string, origin: string): Promise<void>;
  send(id: string, text: string): Promise<boolean>;
  close(id: string): Promise<void>;
  subscribe(handlers: LinkEvents): () => void;
}
