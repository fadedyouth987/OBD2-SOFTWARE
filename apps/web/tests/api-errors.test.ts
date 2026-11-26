import { describe, expect, it } from "vitest";
import { serverErrorMessage } from "@/lib/api";

const fb = "The cloud API had a problem. Try again shortly.";

describe("serverErrorMessage", () => {
  it("never shows the detail of an unhandled 500", () => {
    expect(serverErrorMessage(500, "boom", fb)).toBe(fb);
  });
  it("keeps a plain sentence from a deliberate 503", () => {
    expect(serverErrorMessage(503, "Stripe isn't configured on this server.", fb)).toBe("Stripe isn't configured on this server.");
  });
  it("hides stack-trace-like or long text", () => {
    expect(serverErrorMessage(502, 'Traceback (most recent call last):\n  File "app.py"', fb)).toBe(fb);
    expect(serverErrorMessage(503, "x".repeat(250), fb)).toBe(fb);
  });
});
