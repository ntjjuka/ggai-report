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
  type TranscriptMessage,
} from "@/lib/report";
import { allowedNumbers, computePriors, computeStats, factsToText, pickScoreSet, renderStatsFacts, toEffectiveMessages } from "@/lib/stats";
import { getConfig } from "@/server/config";
import { getDb, schema } from "@/server/db";
import { ApiError } from "@/server/errors";
import { loadMessagesForReport } from "@/server/services/conversations";
import { mapFromSnapshot } from "@/server/services/participants";
import { JobLostError, claimReport, getStageResult, heartbeat, logLlmCall, markFailed, markSucceeded, requeueRunning, saveStageResult } from "@/server/services/reports";

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

export type RunResult = "done" | "skipped" | "failed" | "requeued";

/** 재시도 가능한 실패(네트워크 끊김·429·5xx·출력 검증 실패 등)는 사용자 손을 빌리지 않고 이 간격 뒤 자동으로 다시 줄을 선다 */
const AUTO_RETRY_DELAY_SEC = 20;

export async function runReport(reportId: string, deps: PipelineDeps): Promise<RunResult> {
  const cfg = getConfig();
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const claimed = await claimReport(reportId);
  if (!claimed) return "skipped";
  const row = claimed;
  const attempt = row.attemptCount;
  const persona = row.personaName || cfg.PERSONA_NAME;
  const deadline = started + cfg.WORKER_PIPELINE_TIMEOUT_MINUTES * 60_000;
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  // 단계 전환 사이(수 분짜리 LLM 호출 중)에도 살아 있음을 알린다. 끊기면 복구 루프가 되돌리고, 우리는 다음 체크포인트에서 멈춘다.
  // 긴 단계(종합·검증)에서는 진행률을 시간에 따라 조금씩 올리고 "N분째"를 붙여 멈춘 것처럼 보이지 않게 한다 (상한 90%).
  let lost = false;
  let cur = { stage: "LOAD", pct: 2, message: "", at: now() };
  const hb = setInterval(() => {
    const elapsedMin = Math.floor((now() - cur.at) / 60_000);
    const soft = (cur.stage === "SYNTH" || cur.stage === "VALIDATE") && elapsedMin >= 1 ? { stage: cur.stage, pct: Math.min(90, cur.pct + elapsedMin * 2), message: `${cur.message.replace(/ \(\d+분째\)$/, "")} (${elapsedMin}분째)` } : undefined;
    heartbeat(reportId, attempt, soft).catch((e) => {
      if (e instanceof JobLostError) lost = true;
    });
  }, 30_000);
  hb.unref();
  const checkDeadline = () => {
    if (lost) throw new JobLostError();
    if (now() > deadline) throw new LlmError("LLM_UNAVAILABLE", "PIPELINE_TIMEOUT", true);
  };
  const progress = (stage: string, pct: number, message: string) => {
    cur = { stage, pct, message, at: now() };
    return heartbeat(reportId, attempt, { stage, pct, message });
  };

  try {
    return await runStages();
  } finally {
    clearInterval(hb);
  }

  async function runStages(): Promise<RunResult> {
  try {
    // [1] LOAD
    await progress("LOAD", 5, `${persona}가 대화를 펼치고 있어요`);
    const { row: conv, messages } = await loadMessagesForReport(row.conversationId);
    const snapshot = row.participantSnapshot;
    const map = mapFromSnapshot(snapshot);
    const participants = snapshot.map((s) => ({ id: s.id, name: s.name, isUploader: s.isUploader }));
    const uploaderId = snapshot.find((s) => s.isUploader)?.id ?? null;
    const focus = row.focus as Focus;

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

    // [4] PLAN — 전사가 크면 청크 읽기는 싼 모델로 (docs/19 1단계)
    const transcriptTokens = transcript.reduce((a, m) => a + m.tokens, 0);
    const chunkModel = transcriptTokens > cfg.LLM_CHUNK_LARGE_TOKENS ? cfg.LLM_CHUNK_MODEL_LARGE : cfg.LLM_CHUNK_MODEL;
    const plan = makePlan(transcript, {
      singlePassMaxTokens: cfg.LLM_SINGLE_PASS_MAX_TOKENS,
      chunkMaxTokens: cfg.LLM_CHUNK_MAX_TOKENS,
      maxTotalTokens: cfg.LLM_MAX_TOTAL_TOKENS,
      maxCostUsd: cfg.LLM_MAX_COST_USD,
      chunkModel,
      synthesisModel: cfg.LLM_SYNTHESIS_MODEL,
    });
    const participantsSig = participants.map((p) => `${p.id}=${p.name}${p.isUploader ? "*" : ""}`).join(",");
    const system = buildSystemPrompt({ name: persona });
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
      const t0 = now();
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
        await logLlmCall({ reportId, stage: req.stage, chunkIndex, model: req.model, requestKey: req.requestKey, attempt, status: code === "LLM_REFUSED" ? "REFUSAL" : code === "LLM_MAX_TOKENS" ? "MAX_TOKENS" : e instanceof LlmError && e.retryable ? "RETRYABLE_ERROR" : "FATAL_ERROR", errorType: code, latencyMs: now() - t0 });
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
          // 대화 단위 캐시 키(보고서 ID 없음): 같은 대화로 다른 보고서를 만들면 청크 추출을 다시 사지 않는다 (RAW_RETENTION_DAYS 동안 보관)
          const requestKey = sha256(`${conv.id}|CHUNK|${systemHash}|${focus}|${participantsSig}|${sha256(text)}|${chunkModel}`);
          try {
            const res = await callLlm<ChunkExtraction>(
              {
                stage: "CHUNK",
                model: chunkModel,
                user,
                schema: ChunkExtractionSchema,
                maxTokens: 32000, // 청크 추출: 사고 토큰 + JSON
                effort: cfg.LLM_CHUNK_EFFORT, // 기본 low: 구조화 추출엔 충분, 사고 토큰(시간·비용) 절감
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
    // 청크가 많으면 종합 입력을 다이어트: 청크당 상위 항목만, 하이라이트 후보 총량 상한 (Opus 입력 토큰 절감)
    const okChunks = chunkResults.filter(Boolean);
    const dense = okChunks.length > 24;
    const chunkJson = plan.mode === "CHUNKED" ? JSON.stringify(okChunks.map((c) => ({ label: c.label, ...(dense ? trimChunkForSynthesis(c.value) : c.value) }))) : null;
    const perChunkHighlights = okChunks.length ? Math.max(2, Math.floor(160 / okChunks.length)) : 25;
    const highlightMessages = plan.mode === "CHUNKED" ? okChunks.flatMap((c) => c.highlights.slice(0, perChunkHighlights)) : [];
    // 인물별 인용 후보: 청크 signals/roastMaterial이 가리킨 그 사람의 실제 메시지 (페르소나 문단 말풍선 재료, 사람당 상한)
    const personaMessages = plan.mode === "CHUNKED" ? collectPersonaCandidates(okChunks.map((c) => c.value), participants.map((p) => p.id), evidence) : new Map<string, TranscriptMessage[]>();
    const personaCandidates = personaMessages.size
      ? [...personaMessages.entries()].map(([pid, msgs]) => `${pid}=${participants.find((p) => p.id === pid)?.name ?? pid}:\n${msgs.map(renderLine).join("\n")}`).join("\n")
      : null;
    const synthUser = buildSynthesisUserPrompt({
      title: conv.title ?? "카카오톡 대화",
      period: `${stats.period.startedAt.slice(0, 10)} ~ ${stats.period.endedAt.slice(0, 10)}`,
      messageCount: stats.total.messages,
      participants,
      focus,
      mood,
      question: row.focusQuestion,
      statsFacts: factsToText(facts),
      scorePriors: priors,
      scoresEnabled: cfg.scoresEnabled,
      mode: plan.mode,
      transcript: plan.mode === "SINGLE" ? renderTranscript(plan.chunks[0].messages) : null,
      chunkJson,
      highlightCandidates: highlightMessages.length ? highlightMessages.map(renderLine).join("\n") : null,
      personaCandidates,
      badgeCatalog: BADGE_CATALOG,
    });
    const synthIds = plan.mode === "SINGLE" ? plan.chunks[0].messages : dedupeMessages([...highlightMessages, ...[...personaMessages.values()].flat()]);
    const synthKey = sha256(`${reportId}|SYNTHESIS|${systemHash}|${sha256(synthUser)}|${cfg.LLM_SYNTHESIS_MODEL}`);
    const synth = await callLlm<ReportDraft>(
      {
        stage: "SYNTHESIS",
        model: cfg.LLM_SYNTHESIS_MODEL,
        user: synthUser,
        schema: ReportDraftSchema,
        maxTokens: 64000, // 종합: 사고 토큰 + 초안 JSON 8~12k
        effort: cfg.LLM_SYNTHESIS_EFFORT, // 기본 medium: high는 사고 토큰으로 1~3분 더 걸린다
        speed: cfg.LLM_FAST_MODE === "synthesis" ? ("fast" as const) : undefined,
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
          { stage: "REPAIR", model: cfg.LLM_SYNTHESIS_MODEL, user: repairUser, schema: RepairResponseSchema, maxTokens: 24000, effort: "low", requestKey: repairKey, hints: { ...hintsBase, messageIds: synthIds.map((m) => m.id), speakerOf: Object.fromEntries(synthIds.map((m) => [m.id, m.pid])) } },
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
      usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, costUsd: usage.costUsd, durationSec: Math.round((now() - started) / 1000), chunkModel: plan.mode === "CHUNKED" ? chunkModel : null, synthesisModel: cfg.LLM_SYNTHESIS_MODEL },
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
    const detail = e instanceof Error ? e.message : String(e);
    // 재시도 가능한 실패는 자동으로 다시 줄을 선다 (청크 결과는 캐시돼 있어 종합만 다시 쓴다). 한도에 닿으면 FAILED(사용자 재시도 가능)
    if (e instanceof LlmError && e.retryable && code !== "PIPELINE_TIMEOUT" && attempt < cfg.WORKER_MAX_ATTEMPTS) {
      clearInterval(hb);
      const next = attempt + 1;
      const requeued = await requeueRunning(reportId, `${persona}가 잠깐 끊겨서 다시 쓰는 중이에요 (${next}/${cfg.WORKER_MAX_ATTEMPTS}번째 시도, ${code})`, { delaySec: AUTO_RETRY_DELAY_SEC });
      if (requeued) {
        console.warn(`[pipeline] ${reportId} ${code}: ${detail.slice(0, 160)} → ${AUTO_RETRY_DELAY_SEC}초 뒤 자동 재시도 (${next}/${cfg.WORKER_MAX_ATTEMPTS})`);
        return "requeued";
      }
    }
    await markFailed(reportId, attempt, code, detail);
    return "failed";
  }
  }
}

/** 종합 프롬프트용 청크 결과 다이어트 (청크 24개 초과 시): 항목 수 상한 + 요약 절단 */
export function trimChunkForSynthesis(v: ChunkExtraction): ChunkExtraction {
  const seenSignal = new Set<string>();
  return {
    summary: v.summary.slice(0, 300),
    events: v.events.slice(0, 4),
    signals: v.signals.filter((s) => !seenSignal.has(s.participantId) && seenSignal.add(s.participantId)).map((s) => ({ ...s, topics: (s.topics ?? []).slice(0, 2), details: (s.details ?? []).slice(0, 2), evidenceIds: s.evidenceIds.slice(0, 1) })),
    highlights: v.highlights.slice(0, 4),
    keywords: v.keywords.slice(0, 6),
    roastMaterial: v.roastMaterial.slice(0, 3),
    conflicts: v.conflicts.slice(0, 2),
    plans: v.plans.slice(0, 2),
    safetyFlags: v.safetyFlags,
  };
}

/** 인물별 인용 후보 수집: 청크 signals·roastMaterial의 근거 ID 중 그 사람이 보낸 메시지만, 시간순 고르게 샘플 (사람당 3~10개, 총 120개) */
export function collectPersonaCandidates(chunks: ChunkExtraction[], participantIds: string[], evidence: Map<string, TranscriptMessage>, total = 120): Map<string, TranscriptMessage[]> {
  const perPerson = Math.max(3, Math.min(10, Math.floor(total / Math.max(1, participantIds.length))));
  const pool = new Map<string, TranscriptMessage[]>();
  const seen = new Set<string>();
  const add = (pid: string, ids: string[]) => {
    for (const id of ids) {
      const m = evidence.get(id);
      if (!m || m.pid !== pid || seen.has(id)) continue;
      seen.add(id);
      const arr = pool.get(pid) ?? [];
      arr.push(m);
      pool.set(pid, arr);
    }
  };
  for (const c of chunks) {
    for (const sg of c.signals) add(sg.participantId, sg.evidenceIds);
    for (const r of c.roastMaterial) add(r.participantId, r.evidenceIds);
  }
  const out = new Map<string, TranscriptMessage[]>();
  for (const pid of participantIds) {
    const arr = (pool.get(pid) ?? []).sort((a, b) => a.index - b.index);
    if (arr.length === 0) continue;
    if (arr.length <= perPerson) {
      out.set(pid, arr);
      continue;
    }
    const step = arr.length / perPerson;
    const picked: TranscriptMessage[] = [];
    for (let i = 0; i < perPerson; i++) picked.push(arr[Math.floor(i * step)]);
    out.set(pid, picked);
  }
  return out;
}

function dedupeMessages(msgs: TranscriptMessage[]): TranscriptMessage[] {
  const seen = new Set<string>();
  const out: TranscriptMessage[] = [];
  for (const m of msgs) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
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
  draft.participants.forEach((p) => p.paragraphs.forEach((par) => push(par.quoteIds)));
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
