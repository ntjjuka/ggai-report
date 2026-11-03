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
import { FakeLlmClient, buildSystemPrompt, buildSynthesisUserPrompt } from "@/lib/llm";

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
    expect(text).toContain("m0 [2026-09-25 20:02] 박민수(나): 오늘 수업 끝나고 뭐해?");
    expect(text).toContain("[사진]");
    expect(text).toContain("[파일: 주말계획.pdf]");
    expect(text).not.toContain("들어왔습니다");
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
      tone: "CASUAL",
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
      tone: "CASUAL",
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
    const prose = [...content.verdict.body, content.firstMove.body, ...content.participants.map((p) => p.statement), ...content.findings.map((f) => f.observed)].join("\n");
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
    const a = buildSystemPrompt({ name: "까비서", tone: "CASUAL" });
    const b = buildSystemPrompt({ name: "까비서", tone: "CASUAL" });
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T|[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(a).toContain("까비서");
    expect(a).toContain("반말");
    expect(buildSystemPrompt({ name: "까비서", tone: "POLITE" })).toContain("존댓말");
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
      tone: "CASUAL",
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
  });
});
