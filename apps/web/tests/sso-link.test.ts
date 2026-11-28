import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { pendingLinkFrom } from "@/lib/sso";

describe("pendingLinkFrom (review H3)", () => {
  const detail = {
    code: "link_required",
    message: "x",
    link_token: "tok-123",
    provider: "Google",
    email_sent: true,
    email_hint: "j***@example.com",
  };

  it("reads the link-required 409", () => {
    expect(pendingLinkFrom(new ApiError(409, "x", detail))).toEqual({
      link_token: "tok-123",
      provider: "Google",
      email_sent: true,
      email_hint: "j***@example.com",
    });
  });

  it("ignores every other error", () => {
    expect(pendingLinkFrom(new ApiError(409, "taken", "This email is already linked"))).toBeNull();
    expect(pendingLinkFrom(new ApiError(400, "x", detail))).toBeNull();
    expect(pendingLinkFrom(new Error("boom"))).toBeNull();
    expect(pendingLinkFrom(new ApiError(409, "x", { ...detail, link_token: 5 }))).toBeNull();
  });
});
