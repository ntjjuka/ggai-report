import { describe, expect, it } from "vitest";
import { trimChunkForSynthesis } from "@/worker/pipeline";

describe("trimChunkForSynthesis", () => {
  it("caps every list and keeps one signal per participant", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i);
    const v = {
      summary: "가".repeat(500),
      events: many(10).map((i) => ({ date: "2026-01-01", title: `e${i}`, summary: "", evidenceIds: ["m1"] })),
      signals: ["p1", "p1", "p2", "p2", "p3"].map((pid, i) => ({ participantId: pid, interest: i, effort: i, toneLabel: "", reason: "", evidenceIds: [] })),
      highlights: many(9).map((i) => ({ messageId: `m${i}`, kind: "funny" as const, caption: "" })),
      keywords: many(12).map(String),
      roastMaterial: many(6).map((i) => ({ participantId: "p1", observation: `o${i}`, evidenceIds: [], device: "" })),
      conflicts: many(5).map(() => ({ startMessageId: "m1", endMessageId: "m2", summary: "", repaired: false, repairedBy: null })),
      plans: many(5).map(() => ({ proposedMessageId: "m1", what: "", followedThrough: "UNKNOWN" as const, evidenceIds: [] })),
      safetyFlags: ["SELF_HARM"],
    };
    const t = trimChunkForSynthesis(v);
    expect(t.summary.length).toBe(300);
    expect(t.events.length).toBe(4);
    expect(t.signals.map((s) => s.participantId)).toEqual(["p1", "p2", "p3"]);
    expect(t.highlights.length).toBe(4);
    expect(t.keywords.length).toBe(6);
    expect(t.roastMaterial.length).toBe(3);
    expect(t.conflicts.length).toBe(2);
    expect(t.plans.length).toBe(2);
    expect(t.safetyFlags).toEqual(["SELF_HARM"]);
  });
});
