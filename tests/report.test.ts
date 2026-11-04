import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseUploads } from "@/lib/parser";
import { computeStats, computePriors, toEffectiveMessages, renderStatsFacts, allowedNumbers, type ParticipantMap } from "@/lib/stats";
import {
  buildTranscript,
  buildEvidenceIndex,
  renderTranscript,
  maskText,
  makePlan,
  chunkByMonth,
  validateDraft,
  applyPatches,
  enforceFinal,
  assembleReport,
  pickMood,
  ReportDraftSchema,
  type ReportDraft,
} from "@/lib/report";
import { FakeLlmClient, buildSynthesisContext, buildSynthesisInstructions, buildSystemPrompt, buildSynthesisUserPrompt } from "@/lib/llm";

const LIMITS = { maxMessages: 300_000, minMessages: 1, maxParticipants: 60 };
const PLAN_CFG = { singlePassMaxTokens: 150_000, chunkMaxTokens: 60_000, maxTotalTokens: 1_500_000, maxCostUsd: 5, chunkModel: "claude-sonnet-5-5", synthesisModel: "claude-opus-5-5" };

function setup(fixture = "android_ko_basic.txt", uploader = "박민수") {
  const chat = parseUploads([{ name: fixture, bytes: new Uint8Array(readFileSync(join(process.cwd(), "docs", "fixtures", fixture))) }], LIMITS);
  const map: ParticipantMap = new Map();
  const parts = chat.participants.map((p, i) => ({ id: `p${i + 1}`, name: p.rawName, isUploader: p.rawName === uploader }));
  chat.participants.forEach((p, i) => map.set(p.rawName, { id: `p${i + 1}`, name: p.rawName, rawNames: [p.rawName], isUploader: p.rawName === uploader }));
  const uploaderId = parts.find((p) => p.isUploader)?.id ?? null;
  const stats = computeStats(chat.messages, map, uploaderId);
  const eff = toEffectiveMessages(chat.messages, map);
  const transcript = buildTranscript(eff, map);
  const evidence = buildEvidenceIndex(transcript);
  const set = parts.length === 2 ? "PAIR" : "GROUP";
  const priors = computePriors(stats, set);
  return { chat, map, parts, uploaderId, stats, eff, transcript, evidence, priors };
}

async function fakeDraft(scenario: ConstructorParameters<typeof FakeLlmClient>[0] = "ok", fixture?: string, uploader?: string) {
  const s = setup(fixture, uploader);
  const fake = new FakeLlmClient(scenario);
  const res = await fake.generateJson<ReportDraft>({
    stage: "SYNTHESIS",
    model: "claude-opus-5-5",
    system: "sys",
    user: "user",
    schema: ReportDraftSchema,
    maxTokens: 16000,
    effort: "high",
    requestKey: "k",
    hints: {
      messageIds: s.transcript.map((m) => m.id),
      participantIds: s.parts.map((p) => p.id),
      speakerOf: Object.fromEntries(s.transcript.map((m) => [m.id, m.pid])),
      uploaderId: s.uploaderId,
      numbers: [71, 29],
      scoreKeys: s.priors.map((p) => p.key),
      priors: Object.fromEntries(s.priors.map((p) => [p.key, p.prior])),
    },
  });
  return { ...s, draft: res.value };
}

describe("transcript", () => {
  it("masks phone/account/url and keeps message ids deterministic", () => {
    expect(maskText("연락은 010-1234-5678로, 계좌 110-123-456789, https://www.example.com/a?b=1")).toBe("연락은 [전화번호]로, 계좌 [계좌], [링크: example.com]");
    const s = setup();
    const text = renderTranscript(s.transcript);
    expect(text).toContain("## 2026-09-25 (금)");
    expect(text).toContain("m0 20:02 박민수(나): 오늘 수업 끝나고 뭐해?");
    expect(text).not.toContain("[사진]"); // 첨부는 LLM 전사에서 제외 (통계에만 반영)
    expect(text).not.toContain("[파일:");
    expect(s.transcript.every((m) => m.kind === "TEXT")).toBe(true);
    expect(text).not.toContain("들어왔습니다");
    expect(text).toContain(" ⏎ "); // 여러 줄 본문은 ⏎로 이어 붙인다
  });

  it("compacts the transcript: merges same-sender runs, shortens laughs, counts repeats, keeps context breaks", () => {
    const s = setup();
    const base = s.transcript[0];
    const mk = (i: number, pid: string, name: string, text: string, minute: number, kind: "TEXT" | "PHOTO" = "TEXT", brk = 0) => ({
      ...base,
      id: `m${i}`,
      index: i,
      pid,
      name,
      isUploader: pid === "p1",
      kind,
      text,
      rawText: text,
      at: `2026-01-05T21:${String(minute).padStart(2, "0")}`,
      ms: Date.UTC(2026, 0, 5, 21, minute),
      contextBreakBefore: brk,
    });
    const msgs = [
      mk(0, "p1", "박민수", "오늘", 0),
      mk(1, "p1", "박민수", "뭐해ㅋㅋㅋㅋㅋㅋㅋㅋ", 1),
      mk(2, "p1", "박민수", "심심해!!!!!", 2),
      mk(3, "p2", "이서연", "ㅇㅇ", 3),
      mk(4, "p2", "이서연", "ㅇㅇ", 3),
      mk(5, "p2", "이서연", "ㅇㅇ", 3),
      mk(6, "p1", "박민수", "5분 뒤 메시지는 안 묶인다", 9),
      mk(7, "p2", "이서연", "생략 뒤 첫 메시지", 10, "TEXT", 4),
    ];
    const lines = renderTranscript(msgs).split("\n");
    expect(lines[0]).toBe("## 2026-01-05 (월)");
    expect(lines[1]).toBe("m0~m2 21:00 박민수(나): 오늘 / 뭐해ㅋㅋㅋ / 심심해!!");
    expect(lines[2]).toBe("m3~m5 21:03 이서연: ㅇㅇ ×3");
    expect(lines[3]).toBe("m6 21:09 박민수(나): 5분 뒤 메시지는 안 묶인다");
    expect(lines[4]).toBe("[다른 참여자 메시지 4개 생략]");
    expect(lines[5]).toBe("m7 21:10 이서연: 생략 뒤 첫 메시지");
    expect(buildEvidenceIndex(msgs).get("m4")?.text).toBe("ㅇㅇ"); // 묶여도 모든 ID는 근거 색인에 남는다
  });
});

describe("planner", () => {
  it("single pass for small transcripts, chunked with month buckets for large ones", () => {
    const s = setup();
    const plan = makePlan(s.transcript, PLAN_CFG);
    expect(plan.mode).toBe("SINGLE");
    expect(plan.coveragePct).toBe(100);
    // 인위적으로 토큰을 크게 만들어 청크 모드 유도
    const big = s.transcript.map((m, i) => ({ ...m, tokens: 40_000, at: `2025-${String((i % 6) + 1).padStart(2, "0")}-10T10:00` }));
    const plan2 = makePlan(big, PLAN_CFG);
    expect(plan2.mode).toBe("CHUNKED");
    expect(plan2.chunks.length).toBeGreaterThan(1);
    const chunks = chunkByMonth(big, 60_000);
    expect(chunks.every((c) => c.messages.length >= 1)).toBe(true);
  });

  it("chunks and merges 150k tiny messages without RangeError", () => {
    const s = setup();
    const base = s.transcript[0];
    const big = Array.from({ length: 150_000 }, (_, i) => ({ ...base, tokens: 8, index: i, id: `m${i}`, at: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}T10:00` }));
    const plan = makePlan(big, { ...PLAN_CFG, maxTotalTokens: 600_000 });
    expect(plan.mode).toBe("CHUNKED");
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.coveragePct).toBeLessThanOrEqual(100);
  });

  it("samples to coverage < 100 when exceeding max total tokens and throws when cost cap is impossible", () => {
    const s = setup();
    const huge = Array.from({ length: 400 }, (_, i) => ({ ...s.transcript[i % s.transcript.length], tokens: 10_000, at: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}T10:00`, index: i, id: `m${i}` }));
    const plan = makePlan(huge, { ...PLAN_CFG, maxTotalTokens: 1_000_000 });
    expect(plan.coveragePct).toBeLessThan(100);
    expect(() => makePlan(huge, { ...PLAN_CFG, maxCostUsd: 0.01 })).toThrowError(expect.objectContaining({ code: "COST_LIMIT_EXCEEDED" }));
  });
});

describe("validator + assembler", () => {
  it("accepts a clean fake draft and assembles full content with evidence text filled", async () => {
    const s = await fakeDraft("ok");
    const ctx = {
      evidence: s.evidence,
      participantIds: s.parts.map((p) => p.id),
      isGroup: s.parts.length > 2,
      scoreKeys: s.priors.map((p) => p.key),
      priors: Object.fromEntries(s.priors.map((p) => [p.key, p.prior])),
      scoresEnabled: true,
      allowedNumbers: allowedNumbers(renderStatsFacts(s.stats, s.chat.messages, s.priors)),
    };
    const v = validateDraft(s.draft, ctx);
    expect(v.violations.filter((x) => x.reason !== "MISSING")).toEqual([]);
    const content = assembleReport(v.draft, {
      reportId: "r1",
      personaName: "까비서",
      mood: pickMood("r1"),
      title: "테스트",
      focus: "AUTO",
      question: null,
      participants: s.parts,
      stats: s.stats,
      priors: s.priors,
      evidence: s.evidence,
      plan: { mode: "SINGLE", coveragePct: 100, chunksTotal: 1, chunksSucceeded: 1 },
      metrics: { ...v.metrics, repaired: false },
      usage: { input: 1000, output: 500, cacheRead: 0, costUsd: 0.01, durationSec: 3, chunkModel: null, synthesisModel: "claude-opus-5-5" },
      generatedAt: "2026-11-03T00:00:00Z",
    });
    expect(content.schemaVersion).toBe(1);
    expect(content.participants.length).toBe(s.parts.length); // 전원
    // 인물 페르소나: 칭호·유형·주제·문단(말풍선은 그 사람 메시지만)
    for (const p of content.participants) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.type.label.length).toBeGreaterThan(0);
      expect(p.paragraphs.length).toBeGreaterThanOrEqual(1);
      for (const par of p.paragraphs) for (const q of par.quotes) expect(q.participantId).toBe(p.participantId);
    }
    expect(content.participants.some((p) => p.paragraphs.some((par) => par.quotes.length > 0))).toBe(true);
    expect(content.participants.every((p) => (p.oneLiner ?? "").startsWith("결론:"))).toBe(true);
    expect(content.verdict.reportTitle).toContain("보고서");
    expect(content.verdict.predictions.length).toBeGreaterThanOrEqual(1);
    for (const p of s.parts) expect(content.verdict.predictions.join("\n").includes(p.id)).toBe(false); // ID는 이름으로 치환
    // 재밌게 읽은 장면: 제목·서술·등장인물(스냅샷에 있는 사람만)·실제 메시지
    expect(content.moments.length).toBeGreaterThanOrEqual(3);
    for (const m of content.moments) {
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.summary.length).toBeGreaterThan(0);
      expect(m.participants.every((x) => s.parts.some((q) => q.id === x.id && q.name === x.name))).toBe(true);
      expect(m.messages.length).toBeGreaterThan(0);
    }
    expect(content.scores.length).toBe(5);
    expect(content.findings.every((f) => f.evidence.every((e) => e.text.length > 0))).toBe(true);
    expect(content.weekChanged.pivot?.text).toBeTruthy();
    expect(content.signature.length).toBeGreaterThan(5);
    expect(content.meta.resolvedFocus).toBe("FRIENDS_GROUP");
  });

  it("scrubs unknown inline message ids from prose and exposes known ones as inlineEvidence", async () => {
    const s = await fakeDraft("ok");
    const valid = s.transcript[2].id;
    s.draft.verdict.body[1] = `그런데 ${valid}를 봐. 그리고 m999999도 봐 (m888888).`;
    s.draft.findings[0].observed = `${s.draft.findings[0].observed} m777777`;
    const ctx = { evidence: s.evidence, participantIds: s.parts.map((p) => p.id), isGroup: true, scoreKeys: [], priors: {}, scoresEnabled: false, allowedNumbers: new Set<number>() };
    const v = validateDraft(s.draft, ctx);
    expect(v.draft.verdict.body[1]).toBe(`그런데 ${valid}를 봐. 그리고 도 봐.`);
    expect(v.draft.findings[0].observed.endsWith("m777777")).toBe(false);
    expect(v.metrics.evidenceDropped).toBeGreaterThanOrEqual(3);
    // evidenceIds 배열은 산문 스크럽 대상이 아니다 (keepIds가 따로 처리)
    expect(v.draft.dynamic.evidenceIds.every((id) => /^m\d+$/.test(id))).toBe(true);
    const content = assembleReport(v.draft, {
      reportId: "r2",
      personaName: "까비서",
      mood: pickMood("r2"),
      title: "테스트",
      focus: "AUTO",
      question: null,
      participants: s.parts,
      stats: s.stats,
      priors: s.priors,
      evidence: s.evidence,
      plan: { mode: "SINGLE", coveragePct: 100, chunksTotal: 1, chunksSucceeded: 1 },
      metrics: { ...v.metrics, repaired: false },
      usage: { input: 1, output: 1, cacheRead: 0, costUsd: 0, durationSec: 1, chunkModel: null, synthesisModel: "fake" },
      generatedAt: "2026-11-03T00:00:00Z",
    });
    expect(content.inlineEvidence?.[valid]?.text.length).toBeGreaterThan(0);
    expect(content.inlineEvidence?.m999999).toBeUndefined();
    // 산문 속 participantId는 이름으로 치환, ID 전용 필드는 유지
    const prose = [...content.verdict.body, content.firstMove.body, ...content.participants.flatMap((p) => [p.title, ...p.paragraphs.map((par) => par.text)]), ...content.findings.map((f) => f.observed)].join("\n");
    for (const p of s.parts) expect(prose.includes(p.id)).toBe(false);
    expect(content.participants.every((p) => s.parts.some((q) => q.id === p.participantId))).toBe(true);
  });

  it("drops hallucinated ids and counts them", async () => {
    const s = await fakeDraft("hallucinate_ids");
    const v = validateDraft(s.draft, { evidence: s.evidence, participantIds: s.parts.map((p) => p.id), isGroup: true, scoreKeys: [], priors: {}, scoresEnabled: false, allowedNumbers: new Set() });
    expect(v.metrics.evidenceDropped).toBeGreaterThanOrEqual(2);
    expect(v.draft.dynamic.evidenceIds.includes("m999999")).toBe(false);
    expect(v.draft.scores).toEqual([]);
  });

  it("flags non-korean script and forbidden topics, then enforceFinal removes them", async () => {
    const s = await fakeDraft("hanja");
    const ctx = { evidence: s.evidence, participantIds: s.parts.map((p) => p.id), isGroup: true, scoreKeys: [], priors: {}, scoresEnabled: false, allowedNumbers: new Set<number>() };
    const v = validateDraft(s.draft, ctx);
    expect(v.violations.some((x) => x.reason === "NON_KOREAN_SCRIPT")).toBe(true);
    const fixed = enforceFinal(v.draft, v.violations);
    const v2 = validateDraft(fixed, ctx);
    expect(v2.violations.some((x) => x.reason === "NON_KOREAN_SCRIPT")).toBe(false);

    const f = await fakeDraft("forbidden");
    const vf = validateDraft(f.draft, ctx);
    expect(vf.violations.some((x) => x.reason === "FORBIDDEN_TOPIC")).toBe(true);
  });

  it("reports missing participants and applies repair patches", async () => {
    const s = await fakeDraft("missing_participant");
    const ctx = { evidence: s.evidence, participantIds: s.parts.map((p) => p.id), isGroup: true, scoreKeys: [], priors: {}, scoresEnabled: false, allowedNumbers: new Set<number>() };
    const v = validateDraft(s.draft, ctx);
    expect(v.violations.some((x) => x.reason === "MISSING" && x.path.startsWith("participants"))).toBe(true);
    const patched = applyPatches(v.draft, [{ path: "verdict.headline", valueJson: JSON.stringify("새 헤드라인") }, { path: "findings[0]", valueJson: "null" }]);
    expect(patched.verdict.headline).toBe("새 헤드라인");
    expect(patched.findings.length).toBe(v.draft.findings.length - 1);
  });

  it("drops persona quotes from other speakers, flags empty paragraphs, and enforceFinal blanks a forbidden paragraph", async () => {
    const s = await fakeDraft("ok");
    const ctx = { evidence: s.evidence, participantIds: s.parts.map((p) => p.id), isGroup: true, scoreKeys: [], priors: {}, scoresEnabled: false, allowedNumbers: new Set<number>() };
    const target = s.draft.participants[0];
    const other = s.transcript.find((m) => m.pid !== target.participantId)!;
    target.paragraphs[0].quoteIds = [other.id, ...target.paragraphs[0].quoteIds];
    s.draft.participants[1].paragraphs = [];
    s.draft.participants[0].paragraphs[1].text = "이 사람은 뚱뚱해서 그래.";
    s.draft.participants[0].topics = ["카페", "카페", "주말", "약속", "x", "y"];
    s.draft.moments[0].participantIds = ["ghost", s.parts[0].id, s.parts[0].id];
    const v = validateDraft(s.draft, ctx);
    expect(v.draft.moments[0].participantIds).toEqual([s.parts[0].id]);
    expect(v.draft.participants[0].paragraphs[0].quoteIds.includes(other.id)).toBe(false);
    expect(v.draft.participants[0].topics).toEqual(["카페", "주말", "약속", "x"]);
    expect(v.violations.some((x) => x.reason === "MISSING" && x.path === "participants[1].paragraphs")).toBe(true);
    expect(v.violations.some((x) => x.reason === "FORBIDDEN_TOPIC" && x.path === "participants[0].paragraphs[1].text")).toBe(true);
    const fixed = enforceFinal(v.draft, v.violations);
    expect(fixed.participants[0].paragraphs.length).toBe(1);
    // 본인이 떠든 다이어트 선언은 로스트 소재 — 금지어가 아니다
    const ok = validateDraft({ ...s.draft, participants: s.draft.participants.map((p) => ({ ...p, paragraphs: [{ text: "살쪘다고 선언만 세 번 하고 마라탕을 시켰다.", quoteIds: [] }] })) }, ctx);
    expect(ok.violations.some((x) => x.reason === "FORBIDDEN_TOPIC")).toBe(false);
    // AI 티 어휘는 상담사 톤으로 잡는다
    const ai = validateDraft({ ...s.draft, verdict: { ...s.draft.verdict, body: ["이 방의 소통은 전반적으로 인상적인 모습이다.", "둘째 문단."] } }, ctx);
    expect(ai.violations.some((x) => x.reason === "COUNSELOR_TONE" && x.path === "verdict.body[0]")).toBe(true);
  });

  it("moves inline ids out of persona prose into quote bubbles and flags analyst-style statistics", async () => {
    const s = await fakeDraft("ok");
    const ctx = { evidence: s.evidence, participantIds: s.parts.map((p) => p.id), isGroup: true, scoreKeys: [], priors: {}, scoresEnabled: false, allowedNumbers: new Set<number>() };
    const p0 = s.draft.participants[0];
    const own = s.transcript.filter((m) => m.pid === p0.participantId).map((m) => m.id);
    p0.paragraphs[0] = { text: `큰소리를 쳤는데(${own[0]}), 정작 결과는 한 마리다(${own[1]}, ${own[2]}). 그래도 ${own[0]} 봐.`, quoteIds: [] };
    p0.paragraphs[1] = { text: "선톡 220회로 방 전체 선톡의 31%를 혼자 치고, 새벽 메시지 1571개로 1위다. 평균 7.8자.", quoteIds: [] };
    p0.title = "텍스트 4만 개 낚은 '까부장'";
    p0.oneLiner = "결론: 말은 7.8자, 목표는 7킬로";
    const v = validateDraft(s.draft, ctx);
    const q = v.draft.participants[0];
    expect(q.paragraphs[0].text).toBe("큰소리를 쳤는데, 정작 결과는 한 마리다. 그래도 봐.");
    expect(q.paragraphs[0].quoteIds).toEqual(own.slice(0, 2)); // 문단당 말풍선 ≤2
    expect(v.violations.filter((x) => x.reason === "STATS_IN_PERSONA").map((x) => x.path).sort()).toEqual(["participants[0].oneLiner", "participants[0].paragraphs[1]", "participants[0].title"]);
    // 이야기 속 숫자(날짜·개수·년)는 통계로 보지 않는다
    const story = validateDraft({ ...s.draft, participants: s.draft.participants.map((p) => ({ ...p, title: "소주 열 병 시키고 한 마리 잡은 '조과 한 마리'", oneLiner: "결론: 금연은 월요일마다, 편의점은 매일", paragraphs: [{ text: "1월에 헬스장 6개월을 끊고 3년 만에 참이슬 10병을 주문했다. 5000자 의뢰도 보냈다.", quoteIds: [] }] })) }, ctx);
    expect(story.violations.some((x) => x.reason === "STATS_IN_PERSONA")).toBe(false);
  });

  it("clamps scores to prior ±40 and downgrades confidence", async () => {
    const s = await fakeDraft("ok");
    s.draft.scores = s.priors.map((p) => ({ key: p.key, value: 100, oneLiner: "x", confidence: "HIGH" as const }));
    const v = validateDraft(s.draft, { evidence: s.evidence, participantIds: s.parts.map((p) => p.id), isGroup: true, scoreKeys: s.priors.map((p) => p.key), priors: Object.fromEntries(s.priors.map((p) => [p.key, p.prior])), scoresEnabled: true, allowedNumbers: new Set() });
    for (const sc of v.draft.scores) {
      const prior = s.priors.find((p) => p.key === sc.key)!.prior;
      if (prior !== null) expect(Math.abs(sc.value - prior)).toBeLessThanOrEqual(40);
    }
  });
});

describe("prompts", () => {
  it("system prompt is byte-stable and has no volatile content", () => {
    const a = buildSystemPrompt({ name: "까비서" });
    const b = buildSystemPrompt({ name: "까비서" });
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T|[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(a).toContain("까비서");
    expect(a).toContain("반말");
    expect(a).toContain("존댓말은 쓰지 않는다");
    // 화법 개편: 인물 페르소나 메인, 커뮤니티 어법·밈 팔레트, 뻔한 비유 금지
    expect(a).toContain("인물 페르소나");
    expect(a).toContain("갤주");
    expect(a).toContain("뻔함 금지");
    expect(a).toContain("숫자 규칙");
    expect(a).toContain("폭로자");
    expect(a).toContain("분석가 말투 ✗");
    expect(a).toContain("소재 선택");
    expect(a).toContain("명사형 종결");
    expect(a).toContain("방의 전설");
    expect(a).toContain("관심사(집착)가 로스트의 뼈대다");
  });

  it("synthesis prompt carries facts, priors, mood and question", () => {
    const s = setup();
    const facts = renderStatsFacts(s.stats, s.chat.messages, s.priors);
    const p = buildSynthesisUserPrompt({
      title: "t",
      period: "2026-09-25 ~ 2026-09-26",
      messageCount: 14,
      participants: s.parts,
      focus: "AUTO",
      mood: "DRY",
      question: "얘 나한테 관심 있어?",
      statsFacts: facts.map((f) => `- ${f.text}`).join("\n"),
      scorePriors: s.priors,
      scoresEnabled: true,
      mode: "SINGLE",
      transcript: renderTranscript(s.transcript),
      chunkJson: null,
      highlightCandidates: null,
      badgeCatalog: "first_texter 선톡왕",
    });
    expect(p).toContain("DRY(건조)");
    expect(p).toContain("관심 있어?");
    expect(p).toContain("<transcript>");
    expect(p).toContain("participation_balance");
    expect(p).toContain("participants (메인 코너");
    const chunked = buildSynthesisUserPrompt({ title: "t", period: "p", messageCount: 1, participants: s.parts, focus: "AUTO", mood: "DRY", question: null, statsFacts: "", scorePriors: [], scoresEnabled: false, mode: "CHUNKED", transcript: null, chunkJson: "[]", highlightCandidates: "m1 10:00 a: x", personaCandidates: "p1=a:\nm1 10:00 a: x", interestDigest: "p1=a: 집착 낚시(3)", factLedger: "p1=a:\n  선호 · 2025-03-01 · 해산물 싫어함 (m1)", badgeCatalog: "" });
    expect(chunked).toContain("[인물별 인용 후보 원문");
    expect(chunked).toContain("[사람별 관심사 집계");
    expect(chunked).toContain("p1=a: 집착 낚시(3)");
    expect(chunked).toContain("[인물 팩트 장부");
    expect(chunked).toContain("해산물 싫어함 (m1)");
  });

  it("splits synthesis into a shared context plus per-branch instructions", () => {
    const s = setup();
    const facts = renderStatsFacts(s.stats, s.chat.messages, s.priors);
    const args = { title: "t", period: "p", messageCount: 14, participants: s.parts, focus: "AUTO" as const, mood: "DIRECT" as const, question: null, statsFacts: facts.map((f) => `- ${f.text}`).join("\n"), scorePriors: s.priors, scoresEnabled: true, mode: "SINGLE" as const, transcript: renderTranscript(s.transcript), chunkJson: null, highlightCandidates: null, badgeCatalog: "first_texter 선톡왕" };
    const ctx = buildSynthesisContext(args);
    expect(ctx).toContain("<transcript>");
    expect(ctx).not.toContain("[작성 지침");
    const persona = buildSynthesisInstructions(args, "PERSONA");
    const verdict = buildSynthesisInstructions(args, "VERDICT");
    const all = buildSynthesisInstructions(args, "ALL");
    expect(persona).toContain("participants (메인 코너");
    expect(persona).toContain("[관심사가 뼈대]");
    expect(persona).toContain("[팩트 장부 활용]");
    expect(persona).toContain("결합 라벨");
    expect(persona).toContain("[숫자]");
    expect(persona).toContain("[인용 규칙]");
    expect(persona).toContain("[전설 소환]");
    expect(verdict).toContain("verdict.predictions");
    expect(verdict).toContain("기현상");
    expect(persona).not.toContain("verdict.body");
    expect(verdict).toContain("verdict.body");
    expect(verdict).not.toContain("participants (메인 코너");
    expect(verdict).toContain("떡볶이는 이 호출에서 0회");
    expect(all).toContain("participants (메인 코너");
    expect(all).toContain("verdict.body");
    expect(buildSynthesisUserPrompt(args)).toBe(`${ctx}\n${all}`);
  });
});
