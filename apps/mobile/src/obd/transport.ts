/** A byte pipe to a dongle: Bluetooth LE, classic Bluetooth, or the test emulator. */
export interface Transport {
  readonly label: string;
  write(text: string): Promise<void>;
  /** Text as it arrives, in any chunk size. Returns an unsubscribe function. */
  onData(listener: (chunk: string) => void): () => void;
  /** Fires once if the link drops. Returns an unsubscribe function. */
  onDisconnect(listener: (why: string) => void): () => void;
  close(): Promise<void>;
}
