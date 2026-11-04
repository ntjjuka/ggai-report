import { describe, expect, it } from "vitest";
import { trimChunkForSynthesis } from "@/worker/pipeline";

describe("trimChunkForSynthesis", () => {
  it("caps every list and keeps one signal per participant", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i);
    const v = {
      summary: "가".repeat(500),
      facts: [],
      events: many(10).map((i) => ({ date: "2026-01-01", title: `e${i}`, summary: "", evidenceIds: ["m1"] })),
      signals: ["p1", "p1", "p2", "p2", "p3"].map((pid, i) => ({ participantId: pid, interest: i, effort: i, toneLabel: "", reason: "", topics: ["a", "b", "c"], details: ["d1", "d2", "d3"], callbacks: ["c1", "c2", "c3"], evidenceIds: ["m1", "m2"] })),
      highlights: many(9).map((i) => ({ messageId: `m${i}`, kind: "funny" as const, caption: "" })),
      exchanges: many(3).map((i) => ({ title: `x${i}`, messageIds: ["m1", "m2"], participantIds: ["p1"], why: "" })),
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
    expect(t.exchanges.length).toBe(2);
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
    const chunk = (ids: string[], pid: string, exchanges: { title: string; messageIds: string[]; participantIds: string[]; why: string }[] = []) => ({
      summary: "", facts: [], events: [], highlights: [], keywords: [], conflicts: [], plans: [], safetyFlags: [], exchanges,
      signals: [{ participantId: pid, interest: 0, effort: 0, toneLabel: "", reason: "", topics: [], details: [], callbacks: [], evidenceIds: ids }],
      roastMaterial: [{ participantId: pid, observation: "", evidenceIds: ids, device: "" }],
    });
    const chunks = [
      chunk(["m0", "m1", "m2", "m4", "m999"], "p1"),
      chunk(["m6", "m8", "m10", "m12", "m14", "m16", "m18", "m20", "m22", "m24", "m26"], "p1"),
      // 사건 원문의 메시지도 후보 — 화자별로 나눠 들어간다 (m5·m7은 p2, m28은 p1)
      chunk(["m1", "m3"], "p2", [{ title: "x", messageIds: ["m5", "m28", "m7"], participantIds: ["p1", "p2"], why: "" }]),
    ];
    const out = collectPersonaCandidates(chunks, ["p1", "p2", "p3"], evidence, { topIds: ["p1"], perTop: 6, perRest: 8 });
    const p1 = out.get("p1")!;
    expect(p1.every((m) => m.pid === "p1")).toBe(true); // m1(p2 메시지)·m999(없음) 제외
    expect(p1.length).toBe(6); // 상위 인물 상한 perTop=6, 시간순 고르게
    expect(p1[0].id).toBe("m0");
    expect(out.get("p2")!.map((m) => m.id)).toEqual(["m1", "m3", "m5", "m7"]);
    expect(out.has("p3")).toBe(false);
    // 기본 상한: 상위 25 / 나머지 8
    const big = chunk(Array.from({ length: 30 }, (_, i) => `m${i * 2}`), "p1");
    const big2 = chunk(Array.from({ length: 30 }, (_, i) => `m${i * 2 + 1}`), "p2");
    const out2 = collectPersonaCandidates([big, big2], ["p1", "p2"], evidence, { topIds: ["p1"] });
    expect(out2.get("p1")!.length).toBe(25);
    expect(out2.get("p2")!.length).toBe(8);
  });
});

describe("buildExchangesBlock / batchParticipants / buildPersonaMaterial / renderScenesForPersona", () => {
  const mk = (i: number, pid: string) => ({ id: `m${i}`, index: i, pid, name: pid === "p1" ? "지훈" : "진호", isUploader: false, kind: "TEXT" as const, text: `t${i}`, rawText: `t${i}`, at: "2026-01-01T00:00", ms: i, tokens: 1, contextBreakBefore: 0 });
  const evidence = new Map<string, ReturnType<typeof mk>>();
  for (let i = 0; i < 40; i++) evidence.set(`m${i}`, mk(i, i % 2 === 0 ? "p1" : "p2"));
  const people = [{ id: "p1", name: "지훈" }, { id: "p2", name: "진호" }];
  const chunk = (exchanges: { title: string; messageIds: string[]; participantIds: string[]; why: string }[]) => ({
    summary: "", facts: [], events: [], highlights: [], keywords: [], conflicts: [], plans: [], safetyFlags: [], roastMaterial: [], signals: [], exchanges,
  });

  it("renders exchanges as ordered raw lines, drops unknown ids and one-message exchanges, caps per chunk and dedupes", async () => {
    const { buildExchangesBlock } = await import("@/worker/pipeline");
    const chunks = [
      chunk([
        { title: "허세와 반박", messageIds: ["m3", "m2", "m999"], participantIds: ["p1", "p2"], why: "선언→놀림" },
        { title: "혼자 메시지", messageIds: ["m8"], participantIds: ["p1"], why: "x" },
        { title: "둘째", messageIds: ["m10", "m11"], participantIds: ["p1", "p2"], why: "y" },
        { title: "셋째(청크당 2개 상한)", messageIds: ["m12", "m13"], participantIds: ["p1", "p2"], why: "z" },
      ]),
      chunk([{ title: "중복", messageIds: ["m2", "m3"], participantIds: ["p1", "p2"], why: "dup" }]),
    ];
    const out = buildExchangesBlock(chunks, people, evidence);
    const lines = out.text!.split("\n");
    expect(lines[0]).toBe("[사건 1] 허세와 반박 — 선언→놀림 (지훈·진호)");
    expect(lines[1]).toMatch(/^ {2}m2 .* 지훈: t2$/); // 시간순으로 정렬, 원문 그대로
    expect(lines[2]).toMatch(/^ {2}m3 .* 진호: t3$/);
    expect(lines[3]).toBe("[사건 2] 둘째 — y (지훈·진호)");
    expect(lines.length).toBe(6); // 혼자 메시지·셋째(상한)·중복은 제외
    expect(out.messages.map((m) => m.id)).toEqual(["m2", "m3", "m10", "m11"]);
    expect(buildExchangesBlock([chunk([])], people, evidence).text).toBeNull();
  });

  it("batches majors by size and minors by double size, growing the batch to respect the call cap", async () => {
    const { batchParticipants } = await import("@/worker/pipeline");
    const ids = Array.from({ length: 15 }, (_, i) => `p${i}`);
    const majors = ids.slice(0, 8);
    expect(batchParticipants(["a", "b", "c"], ["a", "b", "c"], { majorSize: 3 })).toEqual([["a", "b", "c"]]);
    expect(batchParticipants(ids.slice(0, 8), majors, { majorSize: 3 })).toEqual([["p0", "p1", "p2"], ["p3", "p4", "p5"], ["p6", "p7"]]);
    // 15명: 상위 8명 3·3·2 + 나머지 7명 6·1 = 5호출 (상한 6 안)
    expect(batchParticipants(ids, majors, { majorSize: 3, maxCalls: 6 }).map((b) => b.length)).toEqual([3, 3, 2, 6, 1]);
    // 30명: 3·3·2 + 22명/6 = 4 → 7호출 > 6 → 묶음을 4로 키워 4·4 + 22/8 = 3 → 5호출
    const thirty = Array.from({ length: 30 }, (_, i) => `q${i}`);
    expect(batchParticipants(thirty, thirty.slice(0, 8), { majorSize: 3, maxCalls: 6 }).map((b) => b.length)).toEqual([4, 4, 8, 8, 6]);
    expect(batchParticipants(ids, majors, { maxCalls: 1 })).toEqual([ids]);
    expect(batchParticipants([], [], {})).toEqual([]);
  });

  it("builds the per-batch focus material from interest lines, ledger lines and candidate lines of those people only", async () => {
    const { buildPersonaMaterial, renderScenesForPersona } = await import("@/worker/pipeline");
    const material = buildPersonaMaterial(["p1", "p3"], {
      ledger: { p1: "  선호 · 2025-03 · 해산물 싫음 (m0)", p2: "  사건 · 2025-09 · 오징어순대 (m1)" },
      candidates: new Map([["p1", "p1=지훈:\nm0 2026-01-01 00:00 지훈: t0\nm2 2026-01-01 00:00 지훈: t2"], ["p2", "p2=진호:\nm1 … 진호: t1"]]),
      interests: "p1=지훈: 집착 테슬라 모델3(3) · 별명·놀림거리 까부장\np2=진호: 집착 쿠팡 반품(1)",
    })!;
    expect(material).toBe("=== p1 ===\n관심사: 집착 테슬라 모델3(3) · 별명·놀림거리 까부장\n팩트 장부(종류 · 연-월 · 사실 · ID):\n  선호 · 2025-03 · 해산물 싫음 (m0)\n인용 후보(이 사람 메시지만):\nm0 2026-01-01 00:00 지훈: t0\nm2 2026-01-01 00:00 지훈: t2");
    expect(material).not.toContain("진호");
    expect(buildPersonaMaterial(["p9"], { ledger: {}, candidates: new Map(), interests: null })).toBeNull();
    const scenes = renderScenesForPersona([{ title: "제1장: '다음 달엔 진짜' — 공용 달력", summary: "첫 문단.\n\n둘째 문단.", participantIds: ["p1", "p2"] }], (pid) => (pid === "p1" ? "지훈" : "진호"))!;
    expect(scenes).toBe("1. 제1장: '다음 달엔 진짜' — 공용 달력 (등장: 지훈·진호)\n   첫 문단. 둘째 문단.");
    expect(renderScenesForPersona([], () => "")).toBeNull();
  });
});

describe("buildInterestDigest", () => {
  it("aggregates chunk topics per person by chunk count and lists callbacks", async () => {
    const { buildInterestDigest } = await import("@/worker/pipeline");
    const chunk = (pid: string, topics: string[], callbacks: string[] = []) => ({
      summary: "", facts: [], events: [], highlights: [], keywords: [], conflicts: [], plans: [], safetyFlags: [], roastMaterial: [], exchanges: [],
      signals: [{ participantId: pid, interest: 0, effort: 0, toneLabel: "", reason: "", topics, details: [], callbacks, evidenceIds: [] }],
    });
    const chunks = [chunk("p1", ["테슬라 모델3", "낚시"], ["까부장"]), chunk("p1", ["테슬라 모델3 ", "주식"], ["까부장"]), chunk("p1", ["테슬라 모델3", "테슬라 모델3"]), chunk("p2", ["쿠팡 반품"])];
    const out = buildInterestDigest(chunks, [{ id: "p1", name: "지훈" }, { id: "p2", name: "진호" }, { id: "p3", name: "눈팅" }])!;
    const lines = out.split("\n");
    expect(lines[0]).toBe("p1=지훈: 집착 테슬라 모델3(3), 낚시(1), 주식(1) · 별명·놀림거리 까부장");
    expect(lines[1]).toBe("p2=진호: 집착 쿠팡 반품(1)");
    expect(lines.length).toBe(2); // 재료 없는 사람은 생략
    expect(buildInterestDigest([], [{ id: "p1", name: "a" }])).toBeNull();
  });
});

describe("buildFactLedger", () => {
  it("collects self-reported facts per person in time order, drops other speakers' ids, dedupes and caps", async () => {
    const { buildFactLedger, stripFacts } = await import("@/worker/pipeline");
    const mk = (i: number, pid: string) => ({ id: `m${i}`, index: i, pid, name: pid, isUploader: false, kind: "TEXT" as const, text: `t${i}`, rawText: `t${i}`, at: `2025-0${(i % 9) + 1}-01T10:00`, ms: i, tokens: 1, contextBreakBefore: 0 });
    const evidence = new Map<string, ReturnType<typeof mk>>();
    for (let i = 0; i < 40; i++) evidence.set(`m${i}`, mk(i, i % 2 === 0 ? "p1" : "p2"));
    const fact = (pid: string, kind: "preference" | "event" | "health", claim: string, when: string, messageId: string) => ({ participantId: pid, kind, claim, when, messageId });
    const chunk = (facts: ReturnType<typeof fact>[]) => ({ summary: "", facts, events: [], highlights: [], keywords: [], conflicts: [], plans: [], safetyFlags: [], roastMaterial: [], signals: [], exchanges: [] });
    const chunks = [
      chunk([fact("p1", "preference", "해산물 냄새만 맡아도 헛구역질", "2025-03-01", "m0"), fact("p1", "health", "통풍 진단 받음", "2025-04-01", "m2"), fact("p2", "event", "속초에서 오징어순대", "2025-09-01", "m1")]),
      chunk([fact("p1", "preference", "해산물 냄새만 맡아도 헛구역질", "2025-03-01", "m0"), fact("p1", "event", "속초에서 오징어순대 먹음", "2025-09-02", "m8"), fact("p1", "event", "남의 메시지", "2025-09-03", "m3"), fact("p1", "event", "없는 메시지", "2025-09-03", "m999")]),
    ];
    const out = buildFactLedger(chunks, [{ id: "p1", name: "지훈" }, { id: "p2", name: "진호" }, { id: "p3", name: "눈팅" }], evidence, { topIds: ["p1"], perTop: 30, perRest: 1 });
    const lines = out.text!.split("\n");
    expect(lines[0]).toBe("p1=지훈:");
    expect(lines[1]).toBe("  선호 · 2025-03 · 해산물 냄새만 맡아도 헛구역질 (m0)");
    expect(lines[2]).toBe("  건강 · 2025-04 · 통풍 진단 받음 (m2)");
    expect(lines[3]).toBe("  사건 · 2025-09 · 속초에서 오징어순대 먹음 (m8)");
    expect(lines[4]).toBe("p2=진호:");
    expect(lines.length).toBe(6); // p2는 1개, 눈팅은 없음, 남의 메시지·없는 메시지는 제외
    expect(out.messages.map((m) => m.id)).toEqual(["m0", "m2", "m8", "m1"]);
    expect(buildFactLedger([], [{ id: "p1", name: "a" }], evidence).text).toBeNull();
    // 사람별 장부 텍스트(인물 묶음 호출의 집중 자료)
    expect(out.byPerson.p1).toBe(lines.slice(1, 4).join("\n"));
    expect(out.byPerson.p2).toBe(lines[5]);
    expect(out.byPerson.p3).toBeUndefined();
    const stripped = stripFacts(chunks[0]);
    expect("facts" in stripped).toBe(false);
    expect("exchanges" in stripped).toBe(false);
  });
});
