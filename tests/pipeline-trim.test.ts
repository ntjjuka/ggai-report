import { describe, expect, it } from "vitest";
import { trimChunkForSynthesis } from "@/worker/pipeline";

describe("trimChunkForSynthesis", () => {
  it("caps every list and keeps one signal per participant", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i);
    const v = {
      summary: "가".repeat(500),
      events: many(10).map((i) => ({ date: "2026-01-01", title: `e${i}`, summary: "", evidenceIds: ["m1"] })),
      signals: ["p1", "p1", "p2", "p2", "p3"].map((pid, i) => ({ participantId: pid, interest: i, effort: i, toneLabel: "", reason: "", topics: ["a", "b", "c"], details: ["d1", "d2", "d3"], callbacks: ["c1", "c2", "c3"], evidenceIds: ["m1", "m2"] })),
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
    expect(t.signals[0].topics).toEqual(["a", "b"]);
    expect(t.signals[0].details).toEqual(["d1", "d2"]);
    expect(t.signals[0].callbacks).toEqual(["c1", "c2"]);
    expect(t.signals[0].evidenceIds).toEqual(["m1"]);
    expect(t.highlights.length).toBe(4);
    expect(t.keywords.length).toBe(6);
    expect(t.roastMaterial.length).toBe(3);
    expect(t.conflicts.length).toBe(2);
    expect(t.plans.length).toBe(2);
    expect(t.safetyFlags).toEqual(["SELF_HARM"]);
  });
});

describe("collectPersonaCandidates", () => {
  it("keeps only the speaker's own messages, dedupes, caps per person and spreads over time", async () => {
    const { collectPersonaCandidates } = await import("@/worker/pipeline");
    const mk = (i: number, pid: string) => ({ id: `m${i}`, index: i, pid, name: pid, isUploader: false, kind: "TEXT" as const, text: `t${i}`, rawText: `t${i}`, at: "2026-01-01T00:00", ms: i, tokens: 1, contextBreakBefore: 0 });
    const evidence = new Map<string, ReturnType<typeof mk>>();
    for (let i = 0; i < 60; i++) evidence.set(`m${i}`, mk(i, i % 2 === 0 ? "p1" : "p2"));
    const chunk = (ids: string[], pid: string) => ({
      summary: "", events: [], highlights: [], keywords: [], conflicts: [], plans: [], safetyFlags: [],
      signals: [{ participantId: pid, interest: 0, effort: 0, toneLabel: "", reason: "", topics: [], details: [], callbacks: [], evidenceIds: ids }],
      roastMaterial: [{ participantId: pid, observation: "", evidenceIds: ids, device: "" }],
    });
    const chunks = [chunk(["m0", "m1", "m2", "m4", "m999"], "p1"), chunk(["m6", "m8", "m10", "m12", "m14", "m16", "m18", "m20", "m22", "m24", "m26"], "p1"), chunk(["m1", "m3"], "p2")];
    const out = collectPersonaCandidates(chunks, ["p1", "p2", "p3"], evidence, 20);
    const p1 = out.get("p1")!;
    expect(p1.every((m) => m.pid === "p1")).toBe(true); // m1(p2 메시지)·m999(없음) 제외
    expect(p1.length).toBe(6); // 사람당 상한 = clamp(floor(20/3), 3, 10) = 6, 시간순 고르게
    expect(p1[0].id).toBe("m0");
    expect(out.get("p2")!.map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(out.has("p3")).toBe(false);
  });
});
