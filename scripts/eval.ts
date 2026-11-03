// 보고서 품질 평가 (docs/11 §5, docs/14 §6): 픽스처(또는 지정 파일) → 단일 패스 종합 → 검증 지표 + 화법 체크.
// 사용: pnpm eval [파일...]            (기본: docs/fixtures/android_ko_basic.txt ios_dotted_24h.txt group_30people.txt)
//       LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... pnpm eval 내대화.txt   (실제 Claude 호출, 비용 발생)
// 출력: 표준 출력 요약 + $TMPDIR/ggai-eval/<파일>.json (초안·검증 결과·최종 보고서)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { config as loadEnv } from "dotenv";
import { AnthropicLlmClient, FakeLlmClient, actualCostUsd, buildSynthesisUserPrompt, buildSystemPrompt, type LlmClient } from "@/lib/llm";
import { parseUploads } from "@/lib/parser";
import { isBotSender } from "@/lib/parser/patterns";
import {
  ReportDraftSchema,
  assembleReport,
  buildEvidenceIndex,
  buildTranscript,
  enforceFinal,
  makePlan,
  pickMood,
  renderTranscript,
  validateDraft,
  type Focus,
  type ReportDraft,
  type Tone,
} from "@/lib/report";
import { allowedNumbers, computePriors, computeStats, factsToText, pickScoreSet, renderStatsFacts, toEffectiveMessages, type ParticipantMap } from "@/lib/stats";
import { BADGES } from "@/lib/tier0";

loadEnv({ quiet: true });

const env = (k: string, d: string) => process.env[k] ?? d;
const PROVIDER = env("LLM_PROVIDER", "fake");
const MODEL = env("LLM_SYNTHESIS_MODEL", "claude-opus-5-5");
const PERSONA = env("PERSONA_NAME", "까비서");
const TONE = env("EVAL_TONE", "CASUAL") as Tone;
const FOCUS = env("EVAL_FOCUS", "AUTO") as Focus;
const QUESTION = process.env.EVAL_QUESTION ?? null;
const DEFAULT_FILES = ["docs/fixtures/android_ko_basic.txt", "docs/fixtures/ios_dotted_24h.txt", "docs/fixtures/group_30people.txt"];
const COUNSELOR = /전반적으로|긍정적인|소통이|성향|노력이 필요|관계는 .{0,6}보입니다/g;
const STOCK = /분위기 메이커|에너지|바이브|리더십|소통왕/g;

function client(): LlmClient {
  if (PROVIDER === "fake") return new FakeLlmClient("ok");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY가 없어요 (LLM_PROVIDER=anthropic)");
  return new AnthropicLlmClient({ apiKey, fallbackModel: env("LLM_FALLBACK_MODEL", "claude-opus-4-8"), timeoutMs: Number(env("LLM_CALL_TIMEOUT_MS", "600000")) });
}

async function evalFile(llm: LlmClient, file: string, outDir: string) {
  const t0 = Date.now();
  const chat = parseUploads([{ name: basename(file), bytes: new Uint8Array(readFileSync(file)) }], { maxMessages: 300_000, minMessages: 1, maxParticipants: 60 });
  const people = chat.participants.filter((p) => !isBotSender(p.rawName));
  const parts = people.map((p, i) => ({ id: `p${i + 1}`, name: p.rawName, isUploader: i === 0 && people.length === 2 }));
  const map: ParticipantMap = new Map(parts.map((p) => [p.name, { id: p.id, name: p.name, rawNames: [p.name], isUploader: p.isUploader }]));
  const uploaderId = parts.find((p) => p.isUploader)?.id ?? null;
  const stats = computeStats(chat.messages, map, uploaderId);
  const priors = computePriors(stats, pickScoreSet(parts.length, FOCUS));
  const facts = renderStatsFacts(stats, chat.messages, priors);
  const eff = toEffectiveMessages(chat.messages, map);
  const transcript = buildTranscript(eff, map);
  const evidence = buildEvidenceIndex(transcript);
  const plan = makePlan(transcript, {
    singlePassMaxTokens: 150_000,
    chunkMaxTokens: 60_000,
    maxTotalTokens: 1_500_000,
    maxCostUsd: Number(env("LLM_MAX_COST_USD", "5")),
    chunkModel: env("LLM_CHUNK_MODEL", "claude-sonnet-5-5"),
    synthesisModel: MODEL,
  });
  if (plan.mode !== "SINGLE") {
    console.log(`\n■ ${file}: 청크 플랜(${plan.chunks.length}개) — eval은 단일 패스만 지원해요. 워커(pnpm worker)로 실행하세요.`);
    return null;
  }
  const mood = pickMood(file);
  const system = buildSystemPrompt({ name: PERSONA, tone: TONE });
  const user = buildSynthesisUserPrompt({
    title: chat.title ?? basename(file),
    period: `${stats.period.startedAt.slice(0, 10)} ~ ${stats.period.endedAt.slice(0, 10)}`,
    messageCount: stats.total.messages,
    participants: parts,
    focus: FOCUS,
    tone: TONE,
    mood,
    question: QUESTION,
    statsFacts: factsToText(facts),
    scorePriors: priors,
    scoresEnabled: true,
    mode: "SINGLE",
    transcript: renderTranscript(plan.chunks[0].messages),
    chunkJson: null,
    highlightCandidates: null,
    badgeCatalog: BADGES.map((b) => `${b.id} ${b.name}(${b.description})`).join(", "),
  });
  const res = await llm.generateJson<ReportDraft>({
    stage: "SYNTHESIS",
    model: MODEL,
    system,
    user,
    schema: ReportDraftSchema,
    maxTokens: 16000,
    effort: "high",
    requestKey: createHash("sha256").update(`eval|${file}|${system.length}|${user.length}`).digest("hex"),
    hints: {
      messageIds: transcript.map((m) => m.id),
      participantIds: parts.map((p) => p.id),
      speakerOf: Object.fromEntries(transcript.map((m) => [m.id, m.pid])),
      uploaderId,
      numbers: [...allowedNumbers(facts)].slice(0, 20),
      scoreKeys: priors.map((p) => p.key),
      priors: Object.fromEntries(priors.map((p) => [p.key, p.prior])),
    },
  });
  const priorMap = Object.fromEntries(priors.map((p) => [p.key, p.prior]));
  const vctx = { evidence, participantIds: parts.map((p) => p.id), isGroup: parts.length > 2, scoreKeys: priors.map((p) => p.key), priors: priorMap, scoresEnabled: true, allowedNumbers: allowedNumbers(facts) };
  const v1 = validateDraft(res.value, vctx);
  const finalDraft = enforceFinal(v1.draft, v1.violations);
  const v2 = validateDraft(finalDraft, vctx);
  const costUsd = actualCostUsd(res.model, res.usage);
  const content = assembleReport(v2.draft, {
    reportId: `eval-${basename(file)}`,
    personaName: PERSONA,
    tone: TONE,
    mood,
    title: chat.title ?? basename(file),
    focus: FOCUS,
    question: QUESTION,
    participants: parts,
    stats,
    priors,
    evidence,
    plan: { mode: "SINGLE", coveragePct: 100, chunksTotal: 1, chunksSucceeded: 1 },
    metrics: { ...v2.metrics, repaired: false },
    usage: { input: res.usage.input, output: res.usage.output, cacheRead: res.usage.cacheRead, costUsd, durationSec: Math.round((Date.now() - t0) / 1000), chunkModel: null, synthesisModel: res.model },
    generatedAt: new Date().toISOString(),
  });

  // 화법 체크 (docs/14 §6)
  const prose = [
    ...content.verdict.body,
    ...content.dynamic.paragraphs,
    content.firstMove.body,
    ...content.participants.map((p) => `${p.statement} ${p.softLanding}`),
    ...content.findings.map((f) => `${f.observed} ${f.interpretation}`),
    ...content.whatIWouldDo.map((w) => w.body),
  ].join("\n");
  const sentences = prose.split(/(?<=[.!?다요])\s+/).filter((s) => s.trim().length > 0);
  const avgLen = sentences.length ? Math.round(sentences.reduce((a, s) => a + [...s].length, 0) / sentences.length) : 0;
  const byReason: Record<string, number> = {};
  for (const x of v1.violations) byReason[x.reason] = (byReason[x.reason] ?? 0) + 1;
  const summary = {
    file,
    provider: llm.provider,
    model: res.model,
    latencyMs: res.latencyMs,
    usage: res.usage,
    costUsd,
    headline: content.verdict.headline,
    headlineLen: [...content.verdict.headline].length,
    violations: byReason,
    evidence: v2.metrics,
    sections: {
      findings: content.findings.length,
      awards: content.awards.length,
      moments: content.moments.length,
      scores: content.scores.length,
      phrases: content.privateLanguage.phrases.length,
      jokes: content.privateLanguage.runningJokes.length,
      weekChanged: content.weekChanged.exists,
    },
    voice: {
      avgSentenceLen: avgLen,
      counselorHits: (prose.match(COUNSELOR) ?? []).length,
      stockHits: (prose.match(STOCK) ?? []).length,
      hanja: /[一-鿿]/.test(prose),
      emojiInHeadline: /\p{Extended_Pictographic}/u.test(content.verdict.headline),
      tteokbokki: (prose.match(/떡볶이/g) ?? []).length,
    },
  };
  const out = join(outDir, `${basename(file)}.json`);
  writeFileSync(out, JSON.stringify({ summary, draft: res.value, validation: { violations: v1.violations, metrics: v1.metrics }, content }, null, 2));
  console.log(`\n■ ${file} → ${out}`);
  console.log(`  헤드라인(${summary.headlineLen}자): ${summary.headline}`);
  console.log(`  모델 ${summary.model} · ${summary.latencyMs}ms · in ${res.usage.input} / out ${res.usage.output} / cacheRead ${res.usage.cacheRead} · $${costUsd.toFixed(4)}`);
  console.log(`  위반: ${JSON.stringify(summary.violations)} · 근거 ${v2.metrics.evidenceTotal - v2.metrics.evidenceDropped}/${v2.metrics.evidenceTotal} · 근거 없는 발견 ${v2.metrics.lowFindings} · 미검증 숫자 ${v2.metrics.unverifiedNumbers}`);
  console.log(`  섹션: ${JSON.stringify(summary.sections)}`);
  console.log(`  화법: 평균 문장 ${avgLen}자 · 상담사 어휘 ${summary.voice.counselorHits} · 재고 라벨 ${summary.voice.stockHits} · 한자 ${summary.voice.hanja} · 헤드라인 이모지 ${summary.voice.emojiInHeadline} · 떡볶이 ${summary.voice.tteokbokki}`);
  return summary;
}

function main(): Promise<void> {
  const args = process.argv.slice(2);
  const files = args.length ? args : DEFAULT_FILES;
  const outDir = join(tmpdir(), "ggai-eval");
  mkdirSync(outDir, { recursive: true });
  const llm = client();
  console.log(`eval: provider=${llm.provider} model=${MODEL} tone=${TONE} focus=${FOCUS} files=${files.length}`);
  return files
    .reduce<Promise<void>>((p, f) => p.then(() => evalFile(llm, f, outDir)).then(() => undefined), Promise.resolve())
    .then(() => console.log(`\n결과 JSON: ${outDir}`));
}

main().catch((e) => {
  console.error("eval failed:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
