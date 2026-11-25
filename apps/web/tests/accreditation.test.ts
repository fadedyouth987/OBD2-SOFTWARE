import { describe, expect, it } from "vitest";
import { ApiError, type AccreditationBlock, type AccreditationRequest } from "@/lib/api";
import { daysLeft, evidenceProblem, stateView, validAbn } from "@/lib/accreditation";
import { describeAccreditationEvent, importProblems, reasonProblem } from "@/lib/admin";

const NOW = new Date("2026-11-25T03:00:00Z").getTime();

function req(over: Partial<AccreditationRequest> = {}): AccreditationRequest {
  return {
    id: "r1",
    kind: "TECHNICIAN",
    status: "APPROVED",
    aasra_member_id: "A-1",
    business_abn: null,
    national_police_check_dated: "2026-01-01",
    repairer_licence_renewed_at: null,
    submitted_at: "2026-01-02T00:00:00Z",
    reviewed_at: "2026-01-03T00:00:00Z",
    decision_reason: null,
    expires_at: null,
    evidence: [],
    ...over,
  };
}

function block(over: Partial<AccreditationBlock>): AccreditationBlock {
  return { state: "not_submitted", current: null, pending: null, latest: null, ...over };
}

describe("accreditation state", () => {
  it("asks for a first submission", () => {
    const v = stateView(block({}), "technician", NOW);
    expect(v.badge).toBe("Not submitted");
    expect(v.canSubmit).toBe(true);
  });

  it("pending can't be resubmitted", () => {
    const v = stateView(block({ state: "pending", pending: req({ status: "PENDING" }) }), "technician", NOW);
    expect(v.badge).toBe("In review");
    expect(v.canSubmit).toBe(false);
  });

  it("shows the rejection reason", () => {
    const latest = req({ status: "REJECTED", decision_reason: "Police check is older than two years" });
    const v = stateView(block({ state: "rejected", latest }), "technician", NOW);
    expect(v.body).toContain("Police check is older");
    expect(v.canSubmit).toBe(true);
  });

  it("warns and offers renewal near expiry", () => {
    const current = req({ expires_at: "2026-12-10T13:29:59Z" });
    const v = stateView(block({ state: "approved", current }), "technician", NOW);
    expect(v.tone).toBe("warn");
    expect(v.canSubmit).toBe(true);
    expect(v.body).toMatch(/expires in 15 days/);
  });

  it("long approvals are calm and not resubmittable", () => {
    const current = req({ expires_at: "2028-01-01T13:29:59Z" });
    const v = stateView(block({ state: "approved", current }), "workshop", NOW);
    expect(v.tone).toBe("ok");
    expect(v.canSubmit).toBe(false);
    expect(v.title).toMatch(/AASRA verification is approved until/);
  });

  it("covers expired, revoked and renewal states", () => {
    expect(stateView(block({ state: "expired" }), "technician", NOW).canSubmit).toBe(true);
    expect(stateView(block({ state: "revoked", latest: req({ decision_reason: "Membership lapsed with AASRA" }) }), "workshop", NOW).body).toContain("lapsed");
    expect(stateView(block({ state: "renewal_pending", current: req({ expires_at: "2027-01-01T00:00:00Z" }) }), "technician", NOW).canSubmit).toBe(false);
  });

  it("counts days left", () => {
    expect(daysLeft(null, NOW)).toBeNull();
    expect(daysLeft("2026-11-24T00:00:00Z", NOW)).toBeLessThan(0);
  });
});

describe("ABN and evidence checks", () => {
  it("validates ABN check sums like the API", () => {
    expect(validAbn("51 824 753 556")).toBe(true);
    expect(validAbn("51824753557")).toBe(false);
    expect(validAbn("1234")).toBe(false);
  });

  const rules = { max_files: 2, max_bytes: 1000, types: ["application/pdf", "image/png", "image/jpeg"] };
  const f = (name: string, size: number, type: string) => new File([new Uint8Array(size)], name, { type });

  it("requires evidence unless dev auto-approve", () => {
    expect(evidenceProblem([], rules, true)).toMatch(/Attach your evidence/);
    expect(evidenceProblem([], rules, false)).toBeNull();
  });

  it("checks count, size and type", () => {
    expect(evidenceProblem([f("a.pdf", 1, "application/pdf"), f("b.pdf", 1, "application/pdf"), f("c.pdf", 1, "application/pdf")], rules, true)).toMatch(/up to 2/);
    expect(evidenceProblem([f("big.pdf", 2000, "application/pdf")], rules, true)).toMatch(/big.pdf is over/);
    expect(evidenceProblem([f("x.docx", 10, "application/msword")], rules, true)).toMatch(/isn't a PDF/);
    expect(evidenceProblem([f("ok.png", 10, "image/png")], rules, true)).toBeNull();
  });
});

describe("admin helpers", () => {
  it("needs a usable reason", () => {
    expect(reasonProblem("   no   ")).toMatch(/10\+/);
    expect(reasonProblem("Evidence is unreadable")).toBeNull();
  });

  it("lists import problems from a 422", () => {
    const e = new ApiError(422, "The procedure file didn't pass the checks", {
      message: "The procedure file didn't pass the checks",
      errors: [{ where: "procedures.0.start", problem: "security access is never allowed" }],
    });
    const p = importProblems(e);
    expect(p.errors).toEqual([{ where: "procedures.0.start", problem: "security access is never allowed" }]);
    expect(importProblems(new ApiError(0, "x")).message).toMatch(/offline/);
  });

  it("describes review history", () => {
    expect(describeAccreditationEvent({ at: null, event: "approved", detail: { dev_auto_approve: true } })).toMatch(/automatically/);
    expect(describeAccreditationEvent({ at: null, event: "rejected", detail: { reason: "Blurry scan" } })).toBe("Rejected: Blurry scan");
    expect(describeAccreditationEvent({ at: null, event: "reminder_sent", detail: { days_left: 7 } })).toMatch(/7 days/);
    expect(describeAccreditationEvent({ at: null, event: "submitted", detail: { evidence_files: 1 } })).toMatch(/1 evidence file$/);
  });
});
