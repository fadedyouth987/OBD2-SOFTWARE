// Turns ELM327 reply lines (headers on, ATH1) into one payload per vehicle module.
//
// CAN 11-bit:  "7E8 06 41 0D 32 00 00 00"   header, ISO-TP PCI byte, data
// CAN 29-bit:  "18 DA F1 10 06 41 0D 32 ..." four header bytes, then the same
// K-line/J1850: "48 6B 10 41 0D 32 C4"        three header bytes, data, checksum
//
// ISO-TP multi-frame replies (VIN, many codes) arrive as a first frame (PCI 1x)
// and consecutive frames (PCI 2x) per module, and are joined here.

export type Bus = "can11" | "can29" | "legacy";

export interface ModuleReply {
  /** Module address as shown by the dongle, e.g. "7E8" or "10". */
  ecu: string;
  payload: number[];
}

/** ELM327 protocol number (ATDPN, "A" prefix = automatic) to bus kind. */
export function busForProtocol(dpn: string): Bus {
  const p = dpn.replace(/^A/i, "").trim().toUpperCase();
  if (p === "6" || p === "8") return "can11";
  if (p === "7" || p === "9") return "can29";
  return "legacy";
}

const bytes = (parts: string[]) => parts.map((p) => Number.parseInt(p, 16));

export class FrameError extends Error {}

export function parseReplyLines(lines: string[], bus: Bus): ModuleReply[] {
  const partial = new Map<string, { expected: number; data: number[]; nextSeq: number }>();
  const done = new Map<string, number[]>();
  const order: string[] = [];
  const remember = (ecu: string) => {
    if (!order.includes(ecu)) order.push(ecu);
  };

  for (const raw of lines) {
    const line = raw.trim().toUpperCase();
    if (!line) continue;
    // Some dongles print 11-bit headers without a space ("7E806..."); split those.
    let parts = line.split(/\s+/);
    if (bus === "can11" && parts.length === 1 && /^[0-9A-F]{5,}$/.test(line) && line.length % 2 === 1) {
      parts = [line.slice(0, 3), ...(line.slice(3).match(/../g) ?? [])];
    }
    if (!parts.every((p) => /^[0-9A-F]+$/.test(p))) throw new FrameError(`Unreadable reply: ${line}`);

    if (bus === "legacy") {
      if (parts.length < 5) continue;
      const ecu = parts[2];
      remember(ecu);
      let data = bytes(parts.slice(3, -1)); // drop the checksum
      const sofar = done.get(ecu);
      // Later frames repeat the service byte (and the PID for mode 09); keep one copy.
      if (sofar && data[0] === sofar[0]) data = data.slice(data[0] === 0x49 ? 2 : 1);
      done.set(ecu, [...(sofar ?? []), ...data]);
      continue;
    }

    const headerLen = bus === "can11" ? 1 : 4;
    if (parts.length <= headerLen) continue;
    const ecu = parts.slice(0, headerLen).join("");
    remember(ecu);
    const body = bytes(parts.slice(headerLen));
    const pci = body[0];
    const kind = pci >> 4;
    if (kind === 0x0) {
      done.set(ecu, body.slice(1, 1 + (pci & 0x0f)));
    } else if (kind === 0x1) {
      const expected = ((pci & 0x0f) << 8) | body[1];
      partial.set(ecu, { expected, data: body.slice(2), nextSeq: 1 });
    } else if (kind === 0x2) {
      const p = partial.get(ecu);
      if (!p) throw new FrameError(`Consecutive frame from ${ecu} without a first frame`);
      if ((pci & 0x0f) !== (p.nextSeq & 0x0f)) throw new FrameError(`Frame out of order from ${ecu}`);
      p.data.push(...body.slice(1));
      p.nextSeq += 1;
      if (p.data.length >= p.expected) {
        done.set(ecu, p.data.slice(0, p.expected));
        partial.delete(ecu);
      }
    }
  }
  if (partial.size) throw new FrameError(`Reply cut short from ${[...partial.keys()].join(", ")}`);
  return order.filter((ecu) => done.has(ecu)).map((ecu) => ({ ecu, payload: done.get(ecu)! }));
}
