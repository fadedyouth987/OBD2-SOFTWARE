// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QrCode } from "@/components/edge/QrCode";
import { PhoneAccessCard, groupFingerprint } from "@/components/edge/PhoneAccessCard";

const request = vi.fn();
const edge = {
  client: { request },
  ready: true,
  mode: "daemon",
  snapshot: { generation: 1 },
};
vi.mock("@/context/edge", () => ({ useEdge: () => edge }));

const FP = "ab".repeat(32);
const ENABLED = {
  type: "LanStatus",
  request_id: "r",
  enabled: true,
  mdns: false,
  port: 8766,
  addresses: ["192.168.1.20"],
  daemon_id: "rcd_0011223344556677",
  daemon_name: "Bay 3 PC",
  fingerprint: FP,
  devices: [
    {
      device_id: "lan_0011223344556677",
      name: "Pixel 8",
      paired_at: "2026-11-20T01:00:00Z",
      paired_by: "u-1",
      last_seen_at: null,
      connected: true,
    },
  ],
};

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("QR code", () => {
  it("draws dark modules as one path on white", () => {
    const { container } = render(<QrCode rows={["101", "010", "101"]} label="code" />);
    const path = container.querySelector("path")!;
    expect(path.getAttribute("d")).toBe("M4 4h1v1h-1zM6 4h1v1h-1zM5 5h1v1h-1zM4 6h1v1h-1zM6 6h1v1h-1z");
    expect(screen.getByRole("img", { name: "code" })).toBeTruthy();
  });

  it("draws nothing for a malformed matrix", () => {
    const { container } = render(<QrCode rows={["10", "1<script>"]} label="x" />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("groups fingerprints for reading aloud", () => {
    expect(groupFingerprint("abcd1234ef567890", 3)).toBe("abcd 1234 ef56");
  });
});

describe("Phone access on the PC", () => {
  it("explains how to turn phone access on when it's off", async () => {
    request.mockResolvedValue({ ...ENABLED, enabled: false, devices: [] });
    await act(async () => {
      render(<PhoneAccessCard />);
    });
    expect(screen.getByText("Phone access is off")).toBeTruthy();
    expect(screen.getByText("edge-daemon lan enable")).toBeTruthy();
  });

  it("shows a single-use code, then the new phone once it pairs", async () => {
    let devices = ENABLED.devices;
    request.mockImplementation(async (msg: { type: string }) => {
      if (msg.type === "LanStatusRequest") return { ...ENABLED, devices };
      if (msg.type === "LanPairOfferRequest")
        return {
          type: "LanPairOffer",
          request_id: "r",
          pairing_uri: "rootcause://lan-pair?v=1",
          host: "192.168.1.20",
          port: 8766,
          fingerprint: FP,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          qr_rows: ["11", "11"],
        };
      throw new Error(msg.type);
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      render(<PhoneAccessCard />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pair a phone" }));
    });
    expect(request).toHaveBeenCalledWith({ type: "LanPairOfferRequest", host: null });
    expect(screen.getByRole("img", { name: /Pairing code for Bay 3 PC at 192.168.1.20:8766/ })).toBeTruthy();
    devices = [...devices, { ...devices[0], device_id: "lan_1111111111111111", name: "Galaxy Tab", connected: false }];
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    expect(screen.getByText(/Galaxy Tab is paired/)).toBeTruthy();
    vi.useRealTimers();
  });

  it("asks before removing a phone, then removes it", async () => {
    request.mockImplementation(async (msg: { type: string }) =>
      msg.type === "LanDeviceRevokeRequest" ? { ...ENABLED, devices: [] } : ENABLED,
    );
    await act(async () => {
      render(<PhoneAccessCard />);
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove Pixel 8" }));
    expect(screen.getByText(/It disconnects now/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(request).toHaveBeenCalledWith({ type: "LanDeviceRevokeRequest", device_id: "lan_0011223344556677" });
    expect(screen.getByText("No phones paired yet.")).toBeTruthy();
  });

  it("says when the daemon is too old to pair phones", async () => {
    const { EdgeRequestError } = await import("@/lib/edge-client");
    request.mockRejectedValue(new EdgeRequestError("PROTOCOL_ERROR", "unknown message", ""));
    await act(async () => {
      render(<PhoneAccessCard />);
    });
    expect(screen.getByText(/too old to pair phones/)).toBeTruthy();
  });
});
