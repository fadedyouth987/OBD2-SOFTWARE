import type { AdapterKind, BusProtocol } from "@/types/edge-protocol";

export interface KindInfo {
  label: string;
  group: "dongle" | "vci" | "can" | "kline" | "virtual";
  note: string;
}

export const KIND_INFO: Record<AdapterKind, KindInfo> = {
  STN_ELM: {
    label: "OBD dongle (STN / ELM327)",
    group: "dongle",
    note: "Bluetooth or USB. OBD-II and UDS reads; J1850 is read-only.",
  },
  J2534: {
    label: "J2534 pass-thru VCI",
    group: "vci",
    note: "Workshop vehicle interface through the pass-thru bridge (Windows).",
  },
  SOCKETCAN: { label: "SocketCAN interface", group: "can", note: "Linux CAN interface (for example can0)." },
  SLCAN: { label: "SLCAN / CANable", group: "can", note: "Serial-line CAN adapter." },
  KLINE_FTDI: { label: "K-line cable (FTDI)", group: "kline", note: "ISO 9141 / KWP2000 for older vehicles." },
  VIRTUAL: {
    label: "Virtual vehicle",
    group: "virtual",
    note: "Simulated by the daemon for training and testing. Not a real car.",
  },
};

export const PROTOCOL_LABEL: Record<BusProtocol, string> = {
  AUTO: "Automatic (recommended)",
  ISO15765_11_500: "CAN 11-bit 500 kbit/s",
  ISO15765_29_500: "CAN 29-bit 500 kbit/s",
  ISO15765_11_250: "CAN 11-bit 250 kbit/s",
  ISO15765_29_250: "CAN 29-bit 250 kbit/s",
  MS_CAN_125: "Medium-speed CAN 125 kbit/s (Ford)",
  BMW_DCAN: "BMW D-CAN",
  ISO14230_FAST: "KWP2000 fast init",
  ISO14230_5BAUD: "KWP2000 5-baud init",
  ISO9141_2: "ISO 9141-2",
  J1850_PWM: "J1850 PWM (Ford, read-only)",
  J1850_VPW: "J1850 VPW (GM, read-only)",
};
