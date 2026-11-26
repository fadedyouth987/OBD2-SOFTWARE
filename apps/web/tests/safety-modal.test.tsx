// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SafetyConfirmModal, type SafetyConfirmProps } from "@/components/safety/SafetyConfirmModal";

const OK = { speedKmh: 0, rpm: 0, batteryV: 12.8, speedAgeMs: 100, rpmAgeMs: 100, batteryAgeMs: 100 };

function props(over: Partial<SafetyConfirmProps> = {}): SafetyConfirmProps {
  return {
    open: true,
    action: "Reset throttle adaptation",
    target: "DME (0x612)",
    consequence: "Learned throttle values are erased.",
    tier: "B",
    live: OK,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...over,
  };
}

const holdButton = () => screen.getByRole("button", { name: /hold to confirm/i });

/** Advance the hold's requestAnimationFrame loop by `ms`. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("SafetyConfirmModal (A-DES-3)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date", "setTimeout", "setInterval"] }));
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("names the action, the module and the consequence", () => {
    render(<SafetyConfirmModal {...props()} />);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Reset throttle adaptation")).toBeTruthy();
    expect(screen.getByText("DME (0x612)")).toBeTruthy();
    expect(screen.getByText("Learned throttle values are erased.")).toBeTruthy();
    expect(screen.getByText(/press and hold for 1\.5 seconds/i)).toBeTruthy();
  });

  it("confirms only after a 1.5 s hold", () => {
    const p = props();
    render(<SafetyConfirmModal {...p} />);
    fireEvent.keyDown(holdButton(), { key: " " });
    advance(1000);
    expect(p.onConfirm).not.toHaveBeenCalled();
    advance(700);
    expect(p.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("releasing early confirms nothing", () => {
    const p = props();
    render(<SafetyConfirmModal {...p} />);
    const button = holdButton();
    fireEvent.keyDown(button, { key: " " });
    advance(800);
    fireEvent.keyUp(button, { key: " " });
    advance(2000);
    expect(p.onConfirm).not.toHaveBeenCalled();
  });

  it("blocks the hold when a reading is missing or stale (fails closed)", () => {
    const p = props({ live: { ...OK, speedKmh: null } });
    const { rerender } = render(<SafetyConfirmModal {...p} />);
    expect((holdButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/waiting for a fresh reading/i)).toBeTruthy();
    rerender(<SafetyConfirmModal {...p} live={{ ...OK, speedAgeMs: 5000 }} />);
    expect((holdButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/stale/i)).toBeTruthy();
  });

  it("stops the hold if a check fails part-way through", () => {
    const p = props();
    const { rerender } = render(<SafetyConfirmModal {...p} />);
    fireEvent.keyDown(holdButton(), { key: " " });
    advance(900);
    rerender(<SafetyConfirmModal {...p} live={{ ...OK, rpm: 850 }} />);
    advance(2000);
    expect(p.onConfirm).not.toHaveBeenCalled();
  });

  it("stops the hold when focus leaves the button", () => {
    const p = props();
    render(<SafetyConfirmModal {...p} />);
    const button = holdButton();
    fireEvent.keyDown(button, { key: " " });
    advance(900);
    fireEvent.blur(button);
    advance(2000);
    expect(p.onConfirm).not.toHaveBeenCalled();
  });

  it("Escape cancels", () => {
    const p = props();
    render(<SafetyConfirmModal {...p} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });
});
