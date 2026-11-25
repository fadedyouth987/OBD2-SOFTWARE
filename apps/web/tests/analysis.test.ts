import { describe, expect, it } from "vitest";
import { engineView, nextRunNote } from "../src/lib/analysis";
import { chargeNote, deletePrompt, deletedText } from "../src/lib/schematics";
import { can, canDeleteFile } from "../src/lib/permissions";
import type { Me, Schematic } from "../src/lib/api";

describe("engineView", () => {
  it("labels a counted model run", () => {
    const v = engineView({ analysis: "llm", analysis_label: "Amazon Bedrock · m1", quota_charged: true, quota_used: 4, quota_limit: 50 });
    expect(v.label).toBe("AI model");
    expect(v.detail).toBe("Amazon Bedrock · m1 · counted 4 of 50 this month");
    expect(v.fallback).toBeNull();
  });
  it("labels rules as free and carries the reason", () => {
    const v = engineView({ analysis: "rules", quota_charged: false, fallback_text: "No AI model is set up on this server, so the built-in rules ran." });
    expect(v.label).toBe("Built-in rules");
    expect(v.detail).toContain("free");
    expect(v.fallback).toContain("No AI model");
  });
  it("treats old stored results by mode", () => {
    expect(engineView({ mode: "FALLBACK_NO_LLM" }).label).toBe("Built-in rules");
    expect(engineView({ mode: "KG_RAG_SYNTHESIS" }).label).toBe("AI model");
  });
  it("explains the next run", () => {
    expect(nextRunNote({ modelConfigured: false, used: 0, limit: 50 })).toContain("built-in rules");
    expect(nextRunNote({ modelConfigured: true, used: 50, limit: 50 })).toContain("used up");
    expect(nextRunNote({ modelConfigured: true, used: 1, limit: 50 })).toContain("Uses one AI diagnosis");
  });
});

const sch = (p: Partial<Schematic>): Schematic => ({
  id: "s1",
  title: "Loom",
  vehicle_profile: null,
  content_type: "application/pdf",
  size_bytes: 1,
  page_count: 3,
  created_at: null,
  ...p,
});

describe("schematic refunds", () => {
  it("says when pages come back", () => {
    expect(deletePrompt(sch({ pages_charged: 3, refundable_pages: 3 }))).toBe("Delete Loom? Its 3 pages go back into this month's allowance.");
    expect(deletePrompt(sch({ pages_charged: 3, refundable_pages: 0 }))).toContain("earlier month");
    expect(deletedText("Loom", { refunded_pages: 1, pages_used: 4, pages_limit: 25 })).toBe(
      "Deleted Loom. 1 page returned: 4 of 25 used this month.",
    );
    expect(deletedText("Loom", { refunded_pages: 0, pages_used: 4, pages_limit: 25 })).toBe("Deleted Loom.");
    expect(chargeNote(sch({ pages_charged: 2, refundable_pages: 2 }))).toContain("refunded if deleted");
    expect(chargeNote(sch({}))).toBeNull();
  });
});

const me = (role: string, permissions?: Me["workspace"]["permissions"]): Me =>
  ({
    user: { id: "u1", email: "a@b.c", display_name: null, last_login_at: null },
    workspace: { tenant_id: "t", name: "W", role, aasra_verified: false, permissions },
  }) as unknown as Me;

describe("permissions", () => {
  it("uses the API list, falling back to the role", () => {
    expect(can(me("TECH", ["MANAGE_ALL_JOBS"]), "MANAGE_ALL_JOBS")).toBe(true);
    expect(can(me("LEAD_TECH"), "MANAGE_ALL_JOBS")).toBe(true);
    expect(can(me("LEAD_TECH"), "MANAGE_BILLING")).toBe(false);
    expect(can(me("OWNER"), "TRANSFER_OWNERSHIP")).toBe(true);
    expect(can(null, "INVITE_MEMBERS")).toBe(false);
  });
  it("lets uploaders and leads delete files", () => {
    expect(canDeleteFile(me("TECH"), "u1")).toBe(true);
    expect(canDeleteFile(me("TECH"), "u2")).toBe(false);
    expect(canDeleteFile(me("LEAD_TECH"), "u2")).toBe(true);
  });
});
