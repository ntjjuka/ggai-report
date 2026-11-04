// docs/08 분석 파이프라인 — LOAD → STATS → RENDER → PLAN → CHUNK×n → SYNTH → VALIDATE/REPAIR → ASSEMBLE
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { BADGES } from "@/lib/tier0/badges";
import { LlmError, actualCostUsd, buildChunkUserPrompt, buildRepairUserPrompt, buildSynthesisContext, buildSynthesisInstructions, buildSystemPrompt, type LlmClient, type Stage, type StageRequest, type StageResponse } from "@/lib/llm";
import {
  ChunkExtractionSchema,
  PersonaBatchSchema,
  PlanError,
  RepairResponseSchema,
  ReportDraftSchema,
  ScenesDraftSchema,
  VerdictDraftSchema,
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
  type PersonaBatch,
  type ReportDraft,
  type ScenesDraft,
  type TranscriptMessage,
  type VerdictDraft,
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

    // [6] SYNTHESIS — 기본은 두 갈래(장면·인물 / 판정·나머지)를 동시에: 스트림 하나가 짧아져 끊김 노출이 줄고 총 시간도 준다 (docs/19 §8)
    const mood: Mood = pickMood(reportId, safetyFlagged);
    // 청크가 많으면 종합 입력을 다이어트: 청크당 상위 항목만, 하이라이트 후보 총량 상한 (Opus 입력 토큰 절감)
    const okChunks = chunkResults.filter(Boolean);
    const dense = okChunks.length > 24;
    // facts는 별도 장부로 넘기므로 청크 JSON에서는 뺀다 (중복 입력 방지)
    const chunkJson = plan.mode === "CHUNKED" ? JSON.stringify(okChunks.map((c) => ({ label: c.label, ...stripFacts(dense ? trimChunkForSynthesis(c.value) : c.value) }))) : null;
    const perChunkHighlights = okChunks.length ? Math.max(2, Math.floor(160 / okChunks.length)) : 25;
    const highlightMessages = plan.mode === "CHUNKED" ? okChunks.flatMap((c) => c.highlights.slice(0, perChunkHighlights)) : [];
    // 인물 팩트 장부: 청크 facts를 사람별·시간순으로. 말 많은 상위 8명은 30개, 나머지 10개 (뒤집힘·결합·선언 vs 결과의 재료)
    const byText = [...stats.perPerson].sort((a, b) => b.textMessages - a.textMessages).map((p) => p.id);
    const majorIds = byText.slice(0, 8);
    const chunkValues = okChunks.map((c) => c.value);
    const ledger = plan.mode === "CHUNKED" ? buildFactLedger(chunkValues, participants, evidence, { topIds: majorIds }) : { text: null, messages: [] as TranscriptMessage[], byPerson: {} as Record<string, string> };
    // 사건 원문: 청크 exchanges(주고받은 2~4개)를 원문 그대로 — 장(章)의 대표 사건과 인물 장면 재구성의 재료 (요약은 웃기지 않다, docs/14 §10)
    const exchanges = plan.mode === "CHUNKED" ? buildExchangesBlock(chunkValues, participants, evidence) : { text: null, messages: [] as TranscriptMessage[] };
    // 인물별 인용 후보: 청크 signals/roastMaterial/exchanges가 가리킨 그 사람의 실제 메시지 + 장부 메시지 (상위 8명 25개, 나머지 8개)
    const personaMessages = plan.mode === "CHUNKED" ? collectPersonaCandidates(chunkValues, participants.map((p) => p.id), evidence, { topIds: majorIds }) : new Map<string, TranscriptMessage[]>();
    for (const m of ledger.messages) {
      const arr = personaMessages.get(m.pid) ?? [];
      if (!arr.some((x) => x.id === m.id)) arr.push(m);
      personaMessages.set(m.pid, arr);
    }
    const nameOf = (pid: string) => participants.find((p) => p.id === pid)?.name ?? pid;
    const personaCandidateLines = new Map([...personaMessages.entries()].map(([pid, msgs]) => [pid, `${pid}=${nameOf(pid)}:\n${msgs.map(renderLine).join("\n")}`] as const));
    const personaCandidates = personaCandidateLines.size ? [...personaCandidateLines.values()].join("\n") : null;
    const interestDigest = plan.mode === "CHUNKED" ? buildInterestDigest(chunkValues, participants) : null;
    const synthArgs = {
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
      interestDigest,
      factLedger: ledger.text,
      exchanges: exchanges.text,
      badgeCatalog: BADGE_CATALOG,
    };
    const synthContext = buildSynthesisContext(synthArgs);
    const synthIds = plan.mode === "SINGLE" ? plan.chunks[0].messages : dedupeMessages([...highlightMessages, ...exchanges.messages, ...[...personaMessages.values()].flat()]);
    const synthHints = { ...hintsBase, messageIds: synthIds.map((m) => m.id), speakerOf: Object.fromEntries(synthIds.map((m) => [m.id, m.pid])) };
    const synthCall = <T>(stage: Exclude<Stage, "CHUNK" | "REPAIR">, schema: StageRequest<T>["schema"], instructions: string, chunkIndex: number, batchIds?: string[]) =>
      callLlm<T>(
        {
          stage,
          model: cfg.LLM_SYNTHESIS_MODEL,
          user: instructions,
          userCached: synthContext, // 공유 문맥은 캐시 경계 뒤에 — 뒤따르는 갈래들이 입력을 10% 단가로 읽는다
          schema,
          maxTokens: 64000, // 종합: 사고 토큰 + 초안 JSON
          // 장·인물 갈래(코미디 설계)는 기본 high: 농담의 설계가 사고 시간에 비례한다. 판정 갈래·한 호출 종합은 LLM_SYNTHESIS_EFFORT
          effort: stage === "SYNTHESIS_PERSONA" || stage === "SYNTHESIS_SCENES" ? cfg.LLM_PERSONA_EFFORT : cfg.LLM_SYNTHESIS_EFFORT,
          speed: cfg.LLM_FAST_MODE === "synthesis" ? ("fast" as const) : undefined,
          requestKey: sha256(`${reportId}|${stage}|${systemHash}|${sha256(synthContext + instructions)}|${cfg.LLM_SYNTHESIS_MODEL}`),
          hints: batchIds ? { ...synthHints, batchIds } : synthHints,
        },
        chunkIndex,
      );
    let synthDraft: ReportDraft;
    let synthModel = cfg.LLM_SYNTHESIS_MODEL;
    if (cfg.LLM_SYNTH_SPLIT === "on") {
      // 세 갈래(docs/08 §7, 14 §10): ① 장(章)만 먼저 — 프롬프트 캐시도 이 호출이 연다 → ② 인물 2~3명 묶음을 병렬로(장을 입력으로 받는다) ∥ ③ 판정·나머지(스태거 뒤 시작)
      const batches = batchParticipants(participants.map((p) => p.id), majorIds, { majorSize: cfg.LLM_PERSONA_BATCH_SIZE, maxCalls: cfg.LLM_PERSONA_MAX_CALLS });
      await progress("SYNTH", 78, `${persona}가 장(章)을 먼저 쓰고, 인물을 ${batches.length}묶음으로 나눠 동시에 쓰고 있어요. 이 단계는 보통 2~4분`);
      const scenesP = synthCall<ScenesDraft>("SYNTHESIS_SCENES", ScenesDraftSchema, buildSynthesisInstructions(synthArgs, "SCENES"), -1);
      scenesP.catch(() => undefined); // 스태거 대기 중 거절돼도 unhandledRejection이 되지 않게 (아래 await가 실제 처리)
      // 판정 갈래는 장 호출이 프롬프트 캐시를 쓴 뒤에 보낸다(첫 응답 시작 시 캐시 열림). 장 호출이 캐시 히트로 바로 끝나면 기다리지 않는다
      await Promise.race([scenesP.catch(() => undefined), sleepMs(cfg.LLM_SYNTH_STAGGER_MS)]);
      const verdictP = synthCall<VerdictDraft>("SYNTHESIS_VERDICT", VerdictDraftSchema, buildSynthesisInstructions(synthArgs, "VERDICT"), -3);
      verdictP.catch(() => undefined);
      const scenesRes = await scenesP; // 인물 묶음은 장을 받아 쓴다 — 장이 실패하면 여기서 던져져 재시도 정책을 탄다
      const scenesText = renderScenesForPersona(scenesRes.value.moments, nameOf);
      const batchResults = await Promise.all(
        batches.map((ids, i) =>
          synthCall<PersonaBatch>(
            "SYNTHESIS_PERSONA",
            PersonaBatchSchema,
            buildSynthesisInstructions(synthArgs, "PERSONA", {
              participants: participants.filter((p) => ids.includes(p.id)),
              majorIds,
              material: buildPersonaMaterial(ids, { ledger: ledger.byPerson, candidates: personaCandidateLines, interests: interestDigest }),
              scenes: scenesText,
            }),
            -(10 + i),
            ids,
          ),
        ),
      );
      const verdictRes = await verdictP;
      synthDraft = { ...verdictRes.value, moments: scenesRes.value.moments, participants: batchResults.flatMap((b) => b.value.participants) };
      synthModel = verdictRes.model;
    } else {
      await progress("SYNTH", 78, `${persona}가 생각을 정리하고 있어요. 이 단계는 보통 2~4분`);
      const synth = await synthCall<ReportDraft>("SYNTHESIS", ReportDraftSchema, buildSynthesisInstructions(synthArgs, "ALL"), -1);
      synthDraft = synth.value;
      synthModel = synth.model;
    }

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
    const firstValidation = validateDraft(synthDraft, vctx); // 근거 탈락(환각 ID) 지표는 원 초안 기준으로 남긴다
    let validation = firstValidation;
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
      metrics: { ...finalCheck.metrics, evidenceTotal: firstValidation.metrics.evidenceTotal, evidenceDropped: firstValidation.metrics.evidenceDropped, repaired },
      usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, costUsd: usage.costUsd, durationSec: Math.round((now() - started) / 1000), chunkModel: plan.mode === "CHUNKED" ? chunkModel : null, synthesisModel: synthModel },
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
    facts: v.facts ?? [], // 장부로 따로 넘기므로 여기선 그대로(stripFacts가 종합 입력에서 뺀다)
    events: v.events.slice(0, 4),
    signals: v.signals.filter((s) => !seenSignal.has(s.participantId) && seenSignal.add(s.participantId)).map((s) => ({ ...s, topics: (s.topics ?? []).slice(0, 2), details: (s.details ?? []).slice(0, 2), callbacks: (s.callbacks ?? []).slice(0, 2), evidenceIds: s.evidenceIds.slice(0, 1) })),
    highlights: v.highlights.slice(0, 4),
    exchanges: (v.exchanges ?? []).slice(0, 2), // 사건 원문 블록으로 따로 넘기므로 stripFacts가 종합 입력에서 뺀다
    keywords: v.keywords.slice(0, 6),
    roastMaterial: v.roastMaterial.slice(0, 3),
    conflicts: v.conflicts.slice(0, 2),
    plans: v.plans.slice(0, 2),
    safetyFlags: v.safetyFlags,
  };
}

/**
 * 인물별 인용 후보 수집: 청크 signals·roastMaterial·exchanges의 근거 ID 중 그 사람이 보낸 메시지만, 시간순 고르게 샘플.
 * 상위 인물(topIds)은 perTop개(기본 25), 나머지는 perRest개(기본 8) — 2026-11-04: 10개로는 가장 창피한 한 줄이 후보에 들 확률이 낮았다(docs/14 §10)
 */
export function collectPersonaCandidates(
  chunks: ChunkExtraction[],
  participantIds: string[],
  evidence: Map<string, TranscriptMessage>,
  opts: { topIds?: string[]; perTop?: number; perRest?: number } = {},
): Map<string, TranscriptMessage[]> {
  const perTop = Math.max(1, opts.perTop ?? 25);
  const perRest = Math.max(1, opts.perRest ?? 8);
  const topIds = new Set(opts.topIds ?? []);
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
    for (const x of c.exchanges ?? []) {
      for (const id of x.messageIds) {
        const m = evidence.get(id);
        if (m) add(m.pid, [id]);
      }
    }
  }
  const out = new Map<string, TranscriptMessage[]>();
  for (const pid of participantIds) {
    const arr = (pool.get(pid) ?? []).sort((a, b) => a.index - b.index);
    if (arr.length === 0) continue;
    const cap = topIds.has(pid) ? perTop : perRest;
    if (arr.length <= cap) {
      out.set(pid, arr);
      continue;
    }
    const step = arr.length / cap;
    const picked: TranscriptMessage[] = [];
    for (let i = 0; i < cap; i++) picked.push(arr[Math.floor(i * step)]);
    out.set(pid, picked);
  }
  return out;
}

const FACT_KIND_LABEL: Record<string, string> = { health: "건강", preference: "선호", possession: "소유", habit: "습관", declaration: "선언", event: "사건", money: "돈", work: "직장", relationship: "관계", other: "기타" };

/** 종합 입력용: facts(장부)·exchanges(사건 원문)는 따로 넘기므로 청크 JSON에서 제거 */
export function stripFacts(v: ChunkExtraction): Omit<ChunkExtraction, "facts" | "exchanges"> {
  const { facts: _facts, exchanges: _exchanges, ...rest } = v;
  return rest;
}

/**
 * 인물 팩트 장부: 청크 facts를 사람별로 모아 시간순 정렬·중복 제거. 상위 인물(topIds)은 perTop개, 나머지는 perRest개 — 시간 전체에 고르게.
 * 근거 메시지가 그 사람 것이어야 하고, 전사에 있어야 한다. 반환 messages는 말풍선 후보로 쓴다.
 */
export function buildFactLedger(
  chunks: ChunkExtraction[],
  participants: { id: string; name: string }[],
  evidence: Map<string, TranscriptMessage>,
  opts: { topIds: string[]; perTop?: number; perRest?: number } = { topIds: [] },
): { text: string | null; messages: TranscriptMessage[]; byPerson: Record<string, string> } {
  const perTop = opts.perTop ?? 30;
  const perRest = opts.perRest ?? 10;
  const byPid = new Map<string, { kind: string; claim: string; when: string; m: TranscriptMessage }[]>();
  const seen = new Set<string>();
  for (const c of chunks) {
    for (const f of c.facts ?? []) {
      const m = evidence.get(f.messageId);
      if (!m || m.pid !== f.participantId) continue;
      const claim = f.claim.replace(/\s+/g, " ").trim().slice(0, 60);
      if (!claim) continue;
      const key = `${f.participantId}|${claim.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const when = /^\d{4}-\d{2}-\d{2}$/.test(f.when) ? f.when : m.at.slice(0, 10);
      const arr = byPid.get(f.participantId) ?? [];
      arr.push({ kind: f.kind, claim, when, m });
      byPid.set(f.participantId, arr);
    }
  }
  const lines: string[] = [];
  const messages: TranscriptMessage[] = [];
  const byPerson: Record<string, string> = {};
  for (const p of participants) {
    const all = (byPid.get(p.id) ?? []).sort((a, b) => a.when.localeCompare(b.when) || a.m.index - b.m.index);
    if (all.length === 0) continue;
    const cap = opts.topIds.includes(p.id) ? perTop : perRest;
    let picked = all;
    if (all.length > cap) {
      const step = all.length / cap;
      picked = Array.from({ length: cap }, (_, i) => all[Math.floor(i * step)]);
    }
    lines.push(`${p.id}=${p.name}:`);
    const own: string[] = [];
    for (const f of picked) {
      own.push(`  ${FACT_KIND_LABEL[f.kind] ?? f.kind} · ${f.when.slice(0, 7)} · ${f.claim} (${f.m.id})`); // 월 단위: 일 단위 날짜가 문단에 그대로 복사되는 것을 막는다
      messages.push(f.m);
    }
    lines.push(...own);
    byPerson[p.id] = own.join("\n");
  }
  return { text: lines.length ? lines.join("\n") : null, messages, byPerson };
}

/** 청크 signals의 topics(구간 수)·callbacks(별명)를 사람별로 집계 — 인물 로스트의 뼈대인 "관심사"를 결정적으로 뽑아 종합에 넘긴다 */
export function buildInterestDigest(chunks: ChunkExtraction[], participants: { id: string; name: string }[], topN = 6): string | null {
  const topics = new Map<string, Map<string, number>>();
  const callbacks = new Map<string, Map<string, number>>();
  const norm = (t: string) => t.replace(/\s+/g, " ").trim().replace(/[.,·]+$/g, "").toLowerCase();
  for (const c of chunks) {
    for (const sg of c.signals) {
      const t = topics.get(sg.participantId) ?? new Map<string, number>();
      for (const raw of new Set((sg.topics ?? []).map(norm).filter((x) => x.length >= 2 && x.length <= 30))) t.set(raw, (t.get(raw) ?? 0) + 1);
      topics.set(sg.participantId, t);
      const cb = callbacks.get(sg.participantId) ?? new Map<string, number>();
      for (const raw of new Set((sg.callbacks ?? []).map(norm).filter((x) => x.length >= 1 && x.length <= 30))) cb.set(raw, (cb.get(raw) ?? 0) + 1);
      callbacks.set(sg.participantId, cb);
    }
  }
  const lines: string[] = [];
  for (const p of participants) {
    const t = [...(topics.get(p.id)?.entries() ?? [])].sort((a, b) => b[1] - a[1]).slice(0, topN);
    const cb = [...(callbacks.get(p.id)?.entries() ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (t.length === 0 && cb.length === 0) continue;
    lines.push(`${p.id}=${p.name}: 집착 ${t.length ? t.map(([k, n]) => `${k}(${n})`).join(", ") : "(없음)"}${cb.length ? ` · 별명·놀림거리 ${cb.map(([k]) => k).join(", ")}` : ""}`);
  }
  return lines.length ? lines.join("\n") : null;
}

/**
 * 사건 원문: 청크 exchanges(주고받은 연속 메시지 2~4개)를 실제 메시지 줄로 펼친다 — 청크당 perChunk개, 총 total개.
 * 종합이 요약 대신 장면(누가 뭐라 했고 누가 받아쳤는지)을 그대로 읽게 한다. 반환 messages는 인용 허용 ID에 더한다.
 */
export function buildExchangesBlock(
  chunks: ChunkExtraction[],
  participants: { id: string; name: string }[],
  evidence: Map<string, TranscriptMessage>,
  opts: { perChunk?: number; total?: number } = {},
): { text: string | null; messages: TranscriptMessage[] } {
  const perChunk = opts.perChunk ?? 2;
  const total = opts.total ?? 40;
  const nameOf = (pid: string) => participants.find((p) => p.id === pid)?.name ?? pid;
  const picked: { title: string; why: string; msgs: TranscriptMessage[] }[] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    let n = 0;
    for (const x of c.exchanges ?? []) {
      if (n >= perChunk || picked.length >= total) break;
      const msgs = [...new Set(x.messageIds)]
        .map((id) => evidence.get(id))
        .filter((m): m is TranscriptMessage => !!m)
        .sort((a, b) => a.index - b.index)
        .slice(0, 4);
      if (msgs.length < 2) continue;
      const key = msgs.map((m) => m.id).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push({ title: x.title.replace(/\s+/g, " ").trim().slice(0, 40), why: x.why.replace(/\s+/g, " ").trim().slice(0, 60), msgs });
      n += 1;
    }
  }
  if (picked.length === 0) return { text: null, messages: [] };
  const lines: string[] = [];
  const messages: TranscriptMessage[] = [];
  picked.forEach((x, i) => {
    const who = [...new Set(x.msgs.map((m) => nameOf(m.pid)))].join("·");
    lines.push(`[사건 ${i + 1}] ${x.title} — ${x.why} (${who})`);
    for (const m of x.msgs) {
      lines.push(`  ${renderLine(m).replace(/^\[다른 참여자 메시지 \d+개 생략\]\n/, "")}`);
      messages.push(m);
    }
  });
  return { text: lines.join("\n"), messages: dedupeMessages(messages) };
}

/**
 * 인물 묶음: 텍스트 지분 상위(majorIds 순서)는 majorSize명씩, 나머지는 그 2배씩 한 호출. 호출 수가 maxCalls를 넘으면 묶음을 키운다.
 * 한 호출이 8명분을 쓰면 뒤로 갈수록 흐려지던 것을 막는다(docs/14 §10) — 호출마다 그 사람들의 장부·후보·장을 집중 자료로 받는다.
 */
export function batchParticipants(ids: string[], majorIds: string[], opts: { majorSize?: number; maxCalls?: number } = {}): string[][] {
  if (ids.length === 0) return [];
  const maxCalls = Math.max(1, opts.maxCalls ?? 6);
  if (maxCalls === 1) return [ids];
  let majorSize = Math.max(1, opts.majorSize ?? 3);
  const majors = majorIds.filter((id) => ids.includes(id));
  const minors = ids.filter((id) => !majors.includes(id));
  const chunk = (arr: string[], size: number) => {
    const out: string[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };
  for (;;) {
    const batches = [...chunk(majors, majorSize), ...chunk(minors, majorSize * 2)];
    if (batches.length <= maxCalls || majorSize >= ids.length) return batches;
    majorSize += 1;
  }
}

/** 인물 묶음 호출의 집중 자료: 이 사람들의 관심사 줄·팩트 장부·인용 후보를 다시 모은다 (공유 문맥에도 있지만 주의를 이 사람들에게 모은다) */
export function buildPersonaMaterial(ids: string[], src: { ledger: Record<string, string>; candidates: Map<string, string>; interests: string | null }): string | null {
  const interestLines = new Map((src.interests ?? "").split("\n").filter(Boolean).map((l) => [l.split("=")[0], l] as const));
  const blocks: string[] = [];
  for (const id of ids) {
    const parts: string[] = [];
    const il = interestLines.get(id);
    if (il) parts.push(`관심사: ${il.slice(il.indexOf(":") + 1).trim()}`);
    const lg = src.ledger[id];
    if (lg) parts.push(`팩트 장부(종류 · 연-월 · 사실 · ID):\n${lg}`);
    const cd = src.candidates.get(id);
    if (cd && cd.includes("\n")) parts.push(`인용 후보(이 사람 메시지만):\n${cd.slice(cd.indexOf("\n") + 1)}`);
    if (parts.length) blocks.push(`=== ${id} ===\n${parts.join("\n")}`);
  }
  return blocks.length ? blocks.join("\n") : null;
}

/** 장(章)을 인물 묶음 호출에 넘길 요약: 번호 · 제목 · 등장인물 · 본문 앞부분 */
export function renderScenesForPersona(moments: { title: string; summary: string; participantIds: string[] }[], nameOf: (pid: string) => string): string | null {
  if (moments.length === 0) return null;
  return moments.map((m, i) => `${i + 1}. ${m.title} (등장: ${m.participantIds.map(nameOf).join("·") || "-"})\n   ${m.summary.replace(/\s*\n\s*/g, " ").slice(0, 320)}`).join("\n");
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
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
