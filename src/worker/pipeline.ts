// docs/08 분석 파이프라인 — LOAD → STATS → RENDER → PLAN → CHUNK×n → SYNTH → VALIDATE/REPAIR → ASSEMBLE
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { BADGES } from "@/lib/tier0/badges";
import { LlmError, actualCostUsd, buildChunkUserPrompt, buildRepairUserPrompt, buildSynthesisUserPrompt, buildSystemPrompt, type LlmClient, type StageRequest, type StageResponse } from "@/lib/llm";
import {
  ChunkExtractionSchema,
  PlanError,
  RepairResponseSchema,
  ReportDraftSchema,
  applyPatches,
  assembleReport,
  buildEvidenceIndex,
  buildTranscript,
  enforceFinal,
  makePlan,
  pickMood,
  renderLine,
  renderTranscript,
  validateDraft,
  type ChunkExtraction,
  type Focus,
  type Mood,
  type ReportDraft,
  type Tone,
  type TranscriptMessage,
} from "@/lib/report";
import { allowedNumbers, computePriors, computeStats, factsToText, pickScoreSet, renderStatsFacts, toEffectiveMessages } from "@/lib/stats";
import { getConfig } from "@/server/config";
import { getDb, schema } from "@/server/db";
import { ApiError } from "@/server/errors";
import { loadMessagesForReport } from "@/server/services/conversations";
import { mapFromSnapshot } from "@/server/services/participants";
import { JobLostError, claimReport, getStageResult, heartbeat, logLlmCall, markFailed, markSucceeded, saveStageResult } from "@/server/services/reports";

export interface PipelineDeps {
  llm: LlmClient;
  now?: () => number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

const BADGE_CATALOG = BADGES.map((b) => `${b.id} ${b.name}(${b.description})`).join(", ");

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function runReport(reportId: string, deps: PipelineDeps): Promise<"done" | "skipped" | "failed"> {
  const cfg = getConfig();
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const row = await claimReport(reportId);
  if (!row) return "skipped";
  const attempt = row.attemptCount;
  const persona = row.personaName || cfg.PERSONA_NAME;
  const deadline = started + cfg.WORKER_PIPELINE_TIMEOUT_MINUTES * 60_000;
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  const checkDeadline = () => {
    if (now() > deadline) throw new LlmError("LLM_UNAVAILABLE", "PIPELINE_TIMEOUT", true);
  };
  const progress = (stage: string, pct: number, message: string) => heartbeat(reportId, attempt, { stage, pct, message });

  try {
    // [1] LOAD
    await progress("LOAD", 5, `${persona}가 대화를 펼치고 있어요`);
    const { row: conv, messages } = await loadMessagesForReport(row.conversationId);
    const snapshot = row.participantSnapshot;
    const map = mapFromSnapshot(snapshot);
    const participants = snapshot.map((s) => ({ id: s.id, name: s.name, isUploader: s.isUploader }));
    const uploaderId = snapshot.find((s) => s.isUploader)?.id ?? null;
    const focus = row.focus as Focus;
    const tone = row.tone as Tone;

    // [2] STATS
    await progress("STATS", 10, `${persona}가 숫자를 세고 있어요 · ${messages.length.toLocaleString()}개 메시지`);
    const stats = computeStats(messages, map, uploaderId);
    const scoreSet = pickScoreSet(participants.length, focus);
    const priors = computePriors(stats, scoreSet);
    const facts = renderStatsFacts(stats, messages, priors);
    const priorMap = Object.fromEntries(priors.map((p) => [p.key, p.prior]));

    // [3] RENDER
    await progress("RENDER", 15, `${persona}가 대화를 정리하고 있어요`);
    const eff = toEffectiveMessages(messages, map);
    const transcript = buildTranscript(eff, map);
    const evidence = buildEvidenceIndex(transcript);
    if (transcript.length === 0) throw new ApiError(422, "NO_MESSAGES", "분석할 메시지가 없어요");

    // [4] PLAN
    const plan = makePlan(transcript, {
      singlePassMaxTokens: cfg.LLM_SINGLE_PASS_MAX_TOKENS,
      chunkMaxTokens: cfg.LLM_CHUNK_MAX_TOKENS,
      maxTotalTokens: cfg.LLM_MAX_TOTAL_TOKENS,
      maxCostUsd: cfg.LLM_MAX_COST_USD,
      chunkModel: cfg.LLM_CHUNK_MODEL,
      synthesisModel: cfg.LLM_SYNTHESIS_MODEL,
    });
    const system = buildSystemPrompt({ name: persona, tone });
    const systemHash = sha256(system).slice(0, 16);
    const scoreKeys = cfg.scoresEnabled ? priors.map((p) => p.key) : [];
    const hintsBase = {
      participantIds: participants.map((p) => p.id),
      uploaderId,
      numbers: [...allowedNumbers(facts)],
      scoreKeys,
      priors: priorMap,
    };
    const callLlm = async <T>(req: Omit<StageRequest<T>, "system">, chunkIndex: number): Promise<StageResponse<T> & { cached: boolean }> => {
      const cached = await getStageResult<T>(req.requestKey);
      if (cached) {
        await logLlmCall({ reportId, stage: req.stage, chunkIndex, model: cached.model, requestKey: req.requestKey, attempt, status: "CACHED" });
        return { value: cached.value, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, model: cached.model, latencyMs: 0, attempts: 0, cached: true };
      }
      checkDeadline();
      try {
        const res = await deps.llm.generateJson<T>({ ...req, system });
        const cost = actualCostUsd(res.model, res.usage);
        usage.input += res.usage.input;
        usage.output += res.usage.output;
        usage.cacheRead += res.usage.cacheRead;
        usage.cacheWrite += res.usage.cacheWrite;
        usage.costUsd += cost;
        await logLlmCall({ reportId, stage: req.stage, chunkIndex, model: res.model, requestKey: req.requestKey, attempt: res.attempts, status: "OK", usage: res.usage, costUsd: cost, latencyMs: res.latencyMs });
        await saveStageResult({ reportId, stage: req.stage, chunkIndex, requestKey: req.requestKey, model: res.model, value: res.value, inputTokens: res.usage.input, outputTokens: res.usage.output });
        return { ...res, cached: false };
      } catch (e) {
        const code = e instanceof LlmError ? e.code : "UNKNOWN";
        await logLlmCall({ reportId, stage: req.stage, chunkIndex, model: req.model, requestKey: req.requestKey, attempt, status: code === "LLM_REFUSED" ? "REFUSAL" : code === "LLM_MAX_TOKENS" ? "MAX_TOKENS" : e instanceof LlmError && e.retryable ? "RETRYABLE_ERROR" : "FATAL_ERROR", errorType: code });
        throw e;
      }
    };

    // [5] CHUNK
    const chunkResults: { label: string; value: ChunkExtraction; highlights: TranscriptMessage[] }[] = [];
    let chunkFailures = 0;
    let safetyFlagged = false;
    if (plan.mode === "CHUNKED") {
      const total = plan.chunks.length;
      let done = 0;
      const pool = Math.max(1, cfg.WORKER_CHUNK_CONCURRENCY);
      const queue = [...plan.chunks];
      const runOne = async () => {
        while (queue.length) {
          const chunk = queue.shift()!;
          const text = renderTranscript(chunk.messages);
          const user = buildChunkUserPrompt({ participants, focus, label: chunk.label, index: chunk.index, total, messageCount: chunk.messages.length, transcript: text });
          const requestKey = sha256(`${reportId}|CHUNK|${chunk.index}|${systemHash}|${sha256(user)}|${cfg.LLM_CHUNK_MODEL}`);
          try {
            const res = await callLlm<ChunkExtraction>(
              {
                stage: "CHUNK",
                model: cfg.LLM_CHUNK_MODEL,
                user,
                schema: ChunkExtractionSchema,
                maxTokens: 8000,
                effort: "medium",
                requestKey,
                hints: { ...hintsBase, messageIds: chunk.messages.map((m) => m.id), speakerOf: Object.fromEntries(chunk.messages.map((m) => [m.id, m.pid])) },
              },
              chunk.index,
            );
            const ids = new Set(res.value.highlights.map((h) => h.messageId));
            const highlights = chunk.messages.filter((m) => ids.has(m.id)).slice(0, 25);
            chunkResults[chunk.index] = { label: chunk.label, value: res.value, highlights };
            if (res.value.safetyFlags.some((f) => f && f !== "NONE")) safetyFlagged = true;
          } catch (e) {
            if (e instanceof LlmError && !e.retryable && e.code === "LLM_REFUSED") throw e;
            if (e instanceof LlmError && e.code === "LLM_BAD_REQUEST") throw e;
            chunkFailures += 1;
            console.warn(`[pipeline] chunk ${chunk.index} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          done += 1;
          await progress("CHUNK", 15 + Math.round((done / total) * 55), `${persona}가 ${chunk.label} 대화를 읽고 있어요 (${done}/${total})`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(pool, total) }, runOne));
      const succeeded = total - chunkFailures;
      if (succeeded / total < 0.6) throw new LlmError("LLM_UNAVAILABLE", "INSUFFICIENT_COVERAGE", true);
    }

    // [6] SYNTHESIS
    await progress("SYNTH", 78, `${persona}가 생각을 정리하고 있어요. 이 단계는 보통 1~2분`);
    const mood: Mood = pickMood(reportId, safetyFlagged);
    const chunkJson = plan.mode === "CHUNKED" ? JSON.stringify(chunkResults.filter(Boolean).map((c) => ({ label: c.label, ...c.value }))) : null;
    const highlightMessages = plan.mode === "CHUNKED" ? chunkResults.filter(Boolean).flatMap((c) => c.highlights) : [];
    const synthUser = buildSynthesisUserPrompt({
      title: conv.title ?? "카카오톡 대화",
      period: `${stats.period.startedAt.slice(0, 10)} ~ ${stats.period.endedAt.slice(0, 10)}`,
      messageCount: stats.total.messages,
      participants,
      focus,
      tone,
      mood,
      question: row.focusQuestion,
      statsFacts: factsToText(facts),
      scorePriors: priors,
      scoresEnabled: cfg.scoresEnabled,
      mode: plan.mode,
      transcript: plan.mode === "SINGLE" ? renderTranscript(plan.chunks[0].messages) : null,
      chunkJson,
      highlightCandidates: highlightMessages.length ? highlightMessages.map(renderLine).join("\n") : null,
      badgeCatalog: BADGE_CATALOG,
    });
    const synthIds = plan.mode === "SINGLE" ? plan.chunks[0].messages : highlightMessages;
    const synthKey = sha256(`${reportId}|SYNTHESIS|${systemHash}|${sha256(synthUser)}|${cfg.LLM_SYNTHESIS_MODEL}`);
    const synth = await callLlm<ReportDraft>(
      {
        stage: "SYNTHESIS",
        model: cfg.LLM_SYNTHESIS_MODEL,
        user: synthUser,
        schema: ReportDraftSchema,
        maxTokens: 16000,
        effort: "high",
        requestKey: synthKey,
        hints: { ...hintsBase, messageIds: synthIds.map((m) => m.id), speakerOf: Object.fromEntries(synthIds.map((m) => [m.id, m.pid])) },
      },
      -1,
    );

    // [7] VALIDATE (+ REPAIR 1회)
    await progress("VALIDATE", 92, "근거를 대조하고 있어요");
    const vctx = {
      evidence,
      participantIds: participants.map((p) => p.id),
      isGroup: participants.length > 2,
      scoreKeys,
      priors: priorMap,
      scoresEnabled: cfg.scoresEnabled,
      allowedNumbers: allowedNumbers(facts),
    };
    let validation = validateDraft(synth.value, vctx);
    let repaired = false;
    const needsRepair = validation.violations.filter((v) => v.reason !== "MISSING" || v.path.startsWith("participants") || v.path === "whatIWouldDo");
    if (needsRepair.length > 0) {
      const allowed = [...new Set([...collectIds(validation.draft), ...synthIds.slice(0, 60).map((m) => m.id)])]
        .map((id) => evidence.get(id))
        .filter((m): m is TranscriptMessage => !!m)
        .map(renderLine)
        .join("\n");
      const repairUser = buildRepairUserPrompt({ draftJson: JSON.stringify(validation.draft), violations: needsRepair, allowedEvidence: allowed });
      const repairKey = sha256(`${reportId}|REPAIR|${systemHash}|${sha256(repairUser)}|${cfg.LLM_SYNTHESIS_MODEL}`);
      try {
        const rep = await callLlm(
          { stage: "REPAIR", model: cfg.LLM_SYNTHESIS_MODEL, user: repairUser, schema: RepairResponseSchema, maxTokens: 8000, effort: "medium", requestKey: repairKey, hints: { ...hintsBase, messageIds: synthIds.map((m) => m.id), speakerOf: Object.fromEntries(synthIds.map((m) => [m.id, m.pid])) } },
          -2,
        );
        const patched = applyPatches(validation.draft, rep.value.patches);
        validation = validateDraft(patched, vctx);
        repaired = true;
      } catch (e) {
        console.warn(`[pipeline] repair skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const finalDraft = enforceFinal(validation.draft, validation.violations);
    const finalCheck = validateDraft(finalDraft, vctx);
    if (finalCheck.draft.verdict.body.length === 0 || !finalCheck.draft.verdict.headline) throw new LlmError("LLM_BAD_OUTPUT", "VALIDATION_FAILED", true);

    // [8] ASSEMBLE
    const content = assembleReport(finalCheck.draft, {
      reportId,
      personaName: persona,
      tone,
      mood,
      title: conv.title ?? "카카오톡 대화",
      focus,
      question: row.focusQuestion,
      participants,
      stats,
      priors,
      evidence,
      plan: { mode: plan.mode, coveragePct: plan.coveragePct, chunksTotal: plan.chunks.length, chunksSucceeded: plan.chunks.length - chunkFailures },
      metrics: { ...finalCheck.metrics, evidenceTotal: validation.metrics.evidenceTotal, evidenceDropped: validation.metrics.evidenceDropped, repaired },
      usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, costUsd: usage.costUsd, durationSec: Math.round((now() - started) / 1000), chunkModel: plan.mode === "CHUNKED" ? cfg.LLM_CHUNK_MODEL : null, synthesisModel: cfg.LLM_SYNTHESIS_MODEL },
      generatedAt: new Date(now()).toISOString(),
    });
    await markSucceeded(reportId, attempt, content);
    return "done";
  } catch (e) {
    if (e instanceof JobLostError) {
      console.info(`[pipeline] ${reportId} lost ownership (canceled or re-claimed)`);
      return "skipped";
    }
    const code = classify(e);
    await markFailed(reportId, attempt, code, e instanceof Error ? e.message : String(e));
    return "failed";
  }
}

function classify(e: unknown): string {
  if (e instanceof PlanError) return e.code;
  if (e instanceof LlmError) {
    if (e.message === "PIPELINE_TIMEOUT" || e.message === "INSUFFICIENT_COVERAGE" || e.message === "VALIDATION_FAILED") return e.message;
    return e.code;
  }
  if (e instanceof ApiError) return e.code;
  return "INTERNAL_ERROR";
}

function collectIds(draft: ReportDraft): string[] {
  const ids: string[] = [];
  const push = (arr: string[]) => ids.push(...arr);
  push(draft.dynamic.evidenceIds);
  push(draft.weekChanged.evidenceIds);
  if (draft.weekChanged.pivotMessageId) ids.push(draft.weekChanged.pivotMessageId);
  draft.participants.forEach((p) => push(p.evidenceIds));
  draft.findings.forEach((f) => push(f.evidenceIds));
  draft.awards.forEach((a) => push(a.evidenceIds));
  draft.moments.forEach((m) => push(m.messageIds));
  if (draft.answer) push(draft.answer.evidenceIds);
  return ids;
}

/** 테스트·관리용: 보고서 행 조회 */
export async function getReportRow(reportId: string) {
  const rows = await getDb().select().from(schema.report).where(eq(schema.report.id, reportId)).limit(1);
  return rows[0] ?? null;
}
