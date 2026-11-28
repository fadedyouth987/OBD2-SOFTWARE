// What the Android app's native daemon link does (modules/daemon-link), in Node
// for the e2e gate: a WebSocket over TLS that trusts only the certificate whose
// SHA-256 matches the pin from the pairing QR code, with the Origin and
// Authorization headers the daemon's network listener requires. Minimal RFC 6455
// client: text frames, ping/pong and close; enough for the daemon protocol.
import { createHash, randomBytes } from "node:crypto";
import { connect, type TLSSocket } from "node:tls";

export type CloseReason = "unreachable" | "identity" | "revoked" | "rejected" | "closed";

export interface PinnedSocket {
  send(text: string): void;
  close(): void;
}

export function openPinned(opts: {
  host: string;
  port: number;
  pin: string;
  authorization: string;
  origin: string;
  onOpen(): void;
  onMessage(text: string): void;
  onClose(wasOpen: boolean, reason: CloseReason, detail?: string): void;
}): PinnedSocket {
  let opened = false;
  let finished = false;
  let buf = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  const finish = (reason: CloseReason, detail?: string) => {
    if (finished) return;
    finished = true;
    sock.destroy();
    opts.onClose(opened, opened ? "closed" : reason, detail);
  };
  // rejectUnauthorized is off because the check is the pin below, done before
  // anything is written: no CA could vouch for a workshop PC's own certificate.
  const sock: TLSSocket = connect({ host: opts.host, port: opts.port, rejectUnauthorized: false });
  const frame = (op: number, payload: Buffer) => {
    const mask = randomBytes(4);
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, 0x80 | len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (len >= 126 && len < 65536) {
      head[0] = 0x80 | op;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else if (len >= 65536) {
      head[0] = 0x80 | op;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    sock.write(Buffer.concat([head, mask, body]));
  };
  sock.once("secureConnect", () => {
    const der = sock.getPeerCertificate(false)?.raw;
    const got = der ? createHash("sha256").update(der).digest("hex") : "";
    if (got !== opts.pin) return finish("identity");
    const key = randomBytes(16).toString("base64");
    sock.write(
      [
        "GET / HTTP/1.1",
        `Host: ${opts.host}:${opts.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Origin: ${opts.origin}`,
        `Authorization: ${opts.authorization}`,
        "",
        "",
      ].join("\r\n"),
    );
  });
  sock.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (!opened) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const status = Number(buf.subarray(0, end).toString("latin1").split(" ")[1]);
      buf = buf.subarray(end + 4);
      if (status !== 101) {
        return finish(status === 401 ? "revoked" : "rejected", `HTTP ${status}`);
      }
      opened = true;
      opts.onOpen();
    }
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (op === 0x8) {
        frame(0x8, Buffer.alloc(0));
        return finish("closed");
      }
      if (op === 0x9) frame(0xa, payload);
      else if (op === 0x1 || op === 0x0) {
        fragments.push(Buffer.from(payload));
        if (fin) {
          opts.onMessage(Buffer.concat(fragments).toString("utf8"));
          fragments = [];
        }
      }
    }
  });
  sock.on("error", (e) => finish("unreachable", e.message));
  sock.on("close", () => finish("unreachable"));
  return {
    send: (text) => {
      if (opened && !finished) frame(0x1, Buffer.from(text, "utf8"));
    },
    close: () => {
      if (finished) return;
      finished = true;
      try {
        frame(0x8, Buffer.alloc(0));
      } catch {}
      sock.end();
    },
  };
}
