// 보고서 서비스 — docs/06 §2, 상태 머신 QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELED
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import type { Focus, ReportContent, Tone } from "@/lib/report/schema";
import { getConfig } from "../config";
import { randomToken, sha256Hex } from "../crypto";
import { getDb, schema } from "../db";
import { ApiError, conflict, notFound } from "../errors";
import { cancelReportJob, enqueueReportJob, getReportJobState, releaseReportJob } from "../queue";
import { assertReportAllowed, audit } from "../ratelimit";
import type { ParticipantSnapshotEntry, ReportRow } from "../schema";
import { buildParticipantMap, snapshotFromMap } from "./participants";

export interface ReportSummary {
  reportId: string;
  seq: number;
  status: string;
  focus: string;
  tone: string;
  progressPct: number;
  createdAt: string;
  finishedAt: string | null;
  headline: string | null;
}

export interface ReportView {
  reportId: string;
  conversationId: string;
  seq: number;
  status: string;
  progress: { stage: string | null; pct: number; message: string | null };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attemptCount: number;
  options: { focus: string; resolvedFocus: string | null; tone: string; focusQuestion: string | null };
  content: ReportContent | null;
  quality: ReportContent["quality"] | null;
  error: { code: string; message: string; retryable: boolean } | null;
  share: { enabled: boolean; url: string | null };
}

const ERROR_MESSAGES: Record<string, string> = {
  LLM_UNAVAILABLE: "까비서가 잠깐 자리를 비웠어요. 다시 시도해 주세요",
  LLM_BAD_REQUEST: "보고서 생성 요청에 문제가 있었어요. 운영팀이 확인 중이에요",
  LLM_REFUSED: "이 대화는 까비서가 분석하지 않기로 했어요",
  LLM_BAD_OUTPUT: "까비서가 보고서를 끝까지 쓰지 못했어요. 다시 시도해 주세요",
  LLM_MAX_TOKENS: "보고서가 너무 길어져서 멈췄어요. 다시 시도해 주세요",
  INSUFFICIENT_COVERAGE: "대화를 충분히 읽지 못했어요. 다시 시도해 주세요",
  COST_LIMIT_EXCEEDED: "대화가 너무 길어서 이번엔 못 읽었어요. 기간을 나눠 올려주세요",
  PIPELINE_TIMEOUT: "생성 시간이 너무 길어져 중단했어요. 다시 시도해 주세요",
  STALE_TIMEOUT: "생성 중 연결이 끊겼어요. 다시 시도해 주세요",
  VALIDATION_FAILED: "보고서 검증을 통과하지 못했어요. 다시 시도해 주세요",
  RAW_EXPIRED: "원문 보관 기간이 지나 생성할 수 없어요",
  QUEUE_ERROR: "작업 대기열에 넣지 못했어요. 다시 시도해 주세요",
  INTERNAL_ERROR: "문제가 생겼어요. 다시 시도해 주세요",
};

const RETRYABLE = new Set(["LLM_UNAVAILABLE", "LLM_BAD_OUTPUT", "LLM_MAX_TOKENS", "INSUFFICIENT_COVERAGE", "PIPELINE_TIMEOUT", "STALE_TIMEOUT", "VALIDATION_FAILED", "QUEUE_ERROR", "INTERNAL_ERROR"]);

export function userMessageFor(code: string): { message: string; retryable: boolean } {
  return { message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL_ERROR, retryable: RETRYABLE.has(code) };
}

export function shareUrl(token: string): string {
  return `${getConfig().APP_BASE_URL.replace(/\/$/, "")}/r/${token}`;
}

export function toReportView(row: ReportRow, shareToken: string | null = null): ReportView {
  return {
    reportId: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    status: row.status,
    progress: { stage: row.progressStage, pct: row.progressPct, message: row.progressMessage },
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    attemptCount: row.attemptCount,
    options: { focus: row.focus, resolvedFocus: row.resolvedFocus, tone: row.tone, focusQuestion: row.focusQuestion },
    content: row.status === "SUCCEEDED" ? row.contentJson : null,
    quality: row.status === "SUCCEEDED" ? row.qualityJson : null,
    error: row.status === "FAILED" && row.errorCode ? { code: row.errorCode, message: row.errorMessage ?? userMessageFor(row.errorCode).message, retryable: row.errorRetryable ?? false } : null,
    share: { enabled: row.shareEnabled, url: row.shareEnabled && shareToken ? shareUrl(shareToken) : null },
  };
}

export async function listReportSummaries(conversationId: string): Promise<ReportSummary[]> {
  const rows = await getDb().select().from(schema.report).where(eq(schema.report.conversationId, conversationId)).orderBy(desc(schema.report.seq));
  return rows.map((r) => ({
    reportId: r.id,
    seq: r.seq,
    status: r.status,
    focus: r.focus,
    tone: r.tone,
    progressPct: r.progressPct,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    headline: r.status === "SUCCEEDED" ? r.contentJson?.verdict.headline ?? null : null,
  }));
}

export interface CreateReportInput {
  focus: Focus;
  tone: Tone;
  focusQuestion: string | null;
}

/**
 * 새 보고서 요청 직전, 이 대화의 "진행 중" 보고서가 사실상 죽은 상태면 정리한다 (웹 쪽 자가 치유 — 워커 버전·생존과 무관).
 * - RUNNING인데 하트비트가 WORKER_STALE_MINUTES 넘게 끊김 → 잡 비우고 FAILED(STALE_TIMEOUT, 재시도 가능)
 * - QUEUED인데 잡이 살아 있지 않음: 2분 넘었으면 다시 enqueue, 10분 넘었으면 FAILED(QUEUE_ERROR, 재시도 가능)
 * 살아 있는 보고서는 건드리지 않으므로, 그 경우엔 그대로 409가 난다.
 */
export async function healStuckReports(conversationId: string, now = new Date()): Promise<{ failed: number; requeued: number }> {
  const cfg = getConfig();
  const db = getDb();
  const rows = await db.select().from(schema.report).where(and(eq(schema.report.conversationId, conversationId), sql`${schema.report.status} IN ('QUEUED','RUNNING')`));
  let failed = 0;
  let requeued = 0;
  for (const r of rows) {
    if (r.status === "RUNNING") {
      const staleAt = now.getTime() - cfg.WORKER_STALE_MINUTES * 60_000;
      if (r.heartbeatAt && r.heartbeatAt.getTime() >= staleAt) continue;
      await releaseReportJob(r.jobId);
      await markFailed(r.id, r.attemptCount, "STALE_TIMEOUT", "워커 응답이 끊겨 중단됨 (새 보고서 요청 시 정리)");
      failed += 1;
      continue;
    }
    const state = await getReportJobState(r.jobId);
    if (state === "created" || state === "retry" || state === "active") continue;
    const ageMs = now.getTime() - r.updatedAt.getTime();
    if (ageMs < 2 * 60_000) continue;
    await releaseReportJob(r.jobId);
    if (ageMs < 10 * 60_000) {
      const jobId = await enqueueReportJob(r.id, r.conversationId).catch(() => null);
      if (jobId) {
        await db.update(schema.report).set({ jobId, updatedAt: now, progressMessage: "다시 줄 서는 중" }).where(eq(schema.report.id, r.id));
        requeued += 1;
        continue;
      }
    }
    await markFailed(r.id, r.attemptCount, "QUEUE_ERROR", "큐에서 유실되어 중단됨 (새 보고서 요청 시 정리)");
    failed += 1;
  }
  return { failed, requeued };
}

export async function createReport(conversationId: string, ownerHash: string, input: CreateReportInput): Promise<ReportView> {
  const cfg = getConfig();
  const db = getDb();
  await assertReportAllowed(ownerHash, cfg.LIMIT_REPORTS_PER_OWNER_PER_DAY);
  const healed = await healStuckReports(conversationId);
  if (healed.failed || healed.requeued) console.info(`[reports] healed stuck reports for ${conversationId}: failed=${healed.failed} requeued=${healed.requeued}`);
  const reportId = randomUUID();
  const created = await db.transaction(async (tx) => {
    const convRows = await tx.select().from(schema.conversation).where(and(eq(schema.conversation.id, conversationId), eq(schema.conversation.ownerTokenHash, ownerHash))).for("update");
    const conv = convRows[0];
    if (!conv) throw notFound();
    if (!conv.rawCipher || conv.status === "RAW_EXPIRED") throw conflict("RAW_EXPIRED", "원문 보관 기간이 지나 새 보고서를 만들 수 없어요");
    const parts = await tx.select().from(schema.participant).where(eq(schema.participant.conversationId, conversationId));
    const map = buildParticipantMap(parts, conv.uploaderParticipantId);
    const snapshot: ParticipantSnapshotEntry[] = snapshotFromMap(map);
    if (snapshot.length < 2) throw conflict("NOT_ENOUGH_PARTICIPANTS", "분석할 참여자가 2명 이상 필요해요");
    const active = await tx.select({ id: schema.report.id, seq: schema.report.seq }).from(schema.report).where(and(eq(schema.report.conversationId, conversationId), sql`${schema.report.status} IN ('QUEUED','RUNNING')`)).limit(1);
    if (active[0]) throw conflict("REPORT_ALREADY_RUNNING", `이미 만들고 있는 보고서(No.${active[0].seq})가 있어요. 끝날 때까지 기다리거나, 그 보고서 화면에서 취소한 뒤 다시 만들어 주세요`);
    const maxSeq = await tx.select({ m: sql<number>`coalesce(max(${schema.report.seq}), 0)::int` }).from(schema.report).where(eq(schema.report.conversationId, conversationId));
    const seq = (maxSeq[0]?.m ?? 0) + 1;
    const rows = await tx
      .insert(schema.report)
      .values({
        id: reportId,
        conversationId,
        seq,
        status: "QUEUED",
        focus: input.focus,
        tone: input.tone,
        focusQuestion: input.focusQuestion?.trim() || null,
        personaName: cfg.PERSONA_NAME,
        participantSnapshot: snapshot,
        progressStage: "QUEUED",
        progressPct: 0,
        progressMessage: `${cfg.PERSONA_NAME}가 줄 서 있어요. 곧 시작해요`,
      })
      .returning();
    return rows[0];
  });
  await audit("REPORT_CREATE", { conversationId, reportId, ownerHash });
  // 커밋 후 큐 투입 (실패 시 FAILED/retryable)
  try {
    let jobId = await enqueueReportJob(reportId, conversationId);
    if (!jobId) {
      // stately 충돌: 이 대화의 끝난 보고서가 남긴 잡(죽은 워커의 active 등)이 singletonKey를 잡고 있다 → 비우고 한 번 더
      const leftovers = await db
        .select({ jobId: schema.report.jobId })
        .from(schema.report)
        .where(and(eq(schema.report.conversationId, conversationId), sql`${schema.report.status} NOT IN ('QUEUED','RUNNING')`, isNotNull(schema.report.jobId)))
        .orderBy(desc(schema.report.createdAt))
        .limit(5);
      for (const l of leftovers) await releaseReportJob(l.jobId);
      jobId = await enqueueReportJob(reportId, conversationId);
    }
    if (jobId) await db.update(schema.report).set({ jobId }).where(eq(schema.report.id, reportId));
    else await markFailed(reportId, created.attemptCount, "QUEUE_ERROR", "큐에 같은 대화의 잡이 남아 있어요 (singleton 충돌)");
  } catch (e) {
    console.error("[reports] enqueue failed:", e instanceof Error ? e.message : String(e));
    await markFailed(reportId, created.attemptCount, "QUEUE_ERROR");
  }
  const fresh = await getDb().select().from(schema.report).where(eq(schema.report.id, reportId)).limit(1);
  return toReportView(fresh[0] ?? created);
}

async function findOwnedReport(reportId: string, ownerHash: string): Promise<ReportRow> {
  const rows = await getDb()
    .select({ r: schema.report })
    .from(schema.report)
    .innerJoin(schema.conversation, eq(schema.conversation.id, schema.report.conversationId))
    .where(and(eq(schema.report.id, reportId), eq(schema.conversation.ownerTokenHash, ownerHash)))
    .limit(1);
  if (!rows[0]) throw notFound();
  return rows[0].r;
}

export async function getReportBySeq(conversationId: string, seq: number, ownerHash: string): Promise<ReportView> {
  const rows = await getDb()
    .select({ r: schema.report })
    .from(schema.report)
    .innerJoin(schema.conversation, eq(schema.conversation.id, schema.report.conversationId))
    .where(and(eq(schema.report.conversationId, conversationId), eq(schema.report.seq, seq), eq(schema.conversation.ownerTokenHash, ownerHash)))
    .limit(1);
  if (!rows[0]) throw notFound();
  return toReportView(rows[0].r, shareTokenCache.get(rows[0].r.id) ?? null);
}

export async function getReportById(reportId: string, ownerHash: string): Promise<ReportView> {
  const row = await findOwnedReport(reportId, ownerHash);
  return toReportView(row, shareTokenCache.get(row.id) ?? null);
}

/** 공유 토큰 원문은 DB에 없으므로(해시만) 발급 직후 응답에만 포함. 재조회 시 URL은 enable 재호출로 받는다. */
const shareTokenCache = new Map<string, string>();

export async function cancelReport(reportId: string, ownerHash: string): Promise<ReportView> {
  const row = await findOwnedReport(reportId, ownerHash);
  if (row.status !== "QUEUED" && row.status !== "RUNNING") throw conflict("INVALID_STATE", `현재 상태(${row.status})에서는 취소할 수 없어요`);
  const updated = await getDb()
    .update(schema.report)
    .set({ status: "CANCELED", finishedAt: new Date(), updatedAt: new Date(), progressMessage: "취소됨" })
    .where(and(eq(schema.report.id, reportId), sql`${schema.report.status} IN ('QUEUED','RUNNING')`))
    .returning();
  if (!updated[0]) throw conflict("INVALID_STATE", "이미 상태가 바뀌었어요");
  await cancelReportJob(row.jobId);
  return toReportView(updated[0]);
}

export async function retryReport(reportId: string, ownerHash: string): Promise<ReportView> {
  const cfg = getConfig();
  const row = await findOwnedReport(reportId, ownerHash);
  if (row.status !== "FAILED") throw conflict("INVALID_STATE", "실패한 보고서만 다시 시도할 수 있어요");
  if (row.attemptCount >= cfg.WORKER_MAX_ATTEMPTS) throw conflict("INVALID_STATE", `재시도 한도(${cfg.WORKER_MAX_ATTEMPTS}회)를 넘었어요. 새 보고서를 만들어 주세요`);
  const conv = await getDb().select({ raw: schema.conversation.rawCipher, status: schema.conversation.status }).from(schema.conversation).where(eq(schema.conversation.id, row.conversationId)).limit(1);
  if (!conv[0]?.raw || conv[0].status === "RAW_EXPIRED") throw conflict("RAW_EXPIRED", "원문 보관 기간이 지나 다시 시도할 수 없어요");
  const updated = await getDb()
    .update(schema.report)
    .set({ status: "QUEUED", errorCode: null, errorMessage: null, errorRetryable: null, progressStage: "QUEUED", progressPct: 0, progressMessage: "다시 줄 서는 중", finishedAt: null, updatedAt: new Date() })
    .where(and(eq(schema.report.id, reportId), eq(schema.report.status, "FAILED")))
    .returning();
  if (!updated[0]) throw conflict("INVALID_STATE", "이미 상태가 바뀌었어요");
  try {
    const jobId = await enqueueReportJob(reportId, row.conversationId);
    if (jobId) await getDb().update(schema.report).set({ jobId }).where(eq(schema.report.id, reportId));
  } catch (e) {
    console.error("[reports] enqueue failed:", e instanceof Error ? e.message : String(e));
    await markFailed(reportId, updated[0].attemptCount, "QUEUE_ERROR");
  }
  return getReportById(reportId, ownerHash);
}

export async function enableShare(reportId: string, ownerHash: string): Promise<{ url: string; token: string }> {
  const row = await findOwnedReport(reportId, ownerHash);
  if (row.status !== "SUCCEEDED") throw conflict("INVALID_STATE", "완성된 보고서만 공유할 수 있어요");
  const token = randomToken();
  await getDb().update(schema.report).set({ shareTokenHash: sha256Hex(token), shareEnabled: true, updatedAt: new Date() }).where(eq(schema.report.id, reportId));
  shareTokenCache.set(reportId, token);
  await audit("SHARE_ON", { reportId, conversationId: row.conversationId, ownerHash });
  return { url: shareUrl(token), token };
}

export async function disableShare(reportId: string, ownerHash: string): Promise<void> {
  const row = await findOwnedReport(reportId, ownerHash);
  await getDb().update(schema.report).set({ shareTokenHash: null, shareEnabled: false, updatedAt: new Date() }).where(eq(schema.report.id, reportId));
  shareTokenCache.delete(reportId);
  await audit("SHARE_OFF", { reportId, conversationId: row.conversationId, ownerHash });
}

/** 보고서 단위 삭제 (docs/18 P0-8). 생성 중이면 409 — 먼저 /cancel. report_stage_result는 CASCADE, llm_call_log는 SET NULL. */
export async function deleteReport(reportId: string, ownerHash: string): Promise<void> {
  const row = await findOwnedReport(reportId, ownerHash);
  if (row.status === "QUEUED" || row.status === "RUNNING") throw conflict("INVALID_STATE", "만드는 중인 보고서는 먼저 취소한 뒤 삭제할 수 있어요");
  await getDb().delete(schema.report).where(eq(schema.report.id, reportId));
  shareTokenCache.delete(reportId);
  // audit_event.report_id는 FK(ON DELETE SET NULL)라 삭제된 ID를 넣을 수 없다 → 대화 ID만 남긴다
  await audit("REPORT_DELETE", { conversationId: row.conversationId, ownerHash });
}

export interface SharedReportView {
  reportId: string;
  seq: number;
  content: ReportContent;
  createdAt: string;
}

export async function getSharedReport(token: string): Promise<SharedReportView> {
  if (!token || token.length < 32) throw notFound();
  const rows = await getDb().select().from(schema.report).where(and(eq(schema.report.shareTokenHash, sha256Hex(token)), eq(schema.report.shareEnabled, true), eq(schema.report.status, "SUCCEEDED"))).limit(1);
  const r = rows[0];
  if (!r || !r.contentJson) throw notFound();
  return { reportId: r.id, seq: r.seq, content: r.contentJson, createdAt: r.createdAt.toISOString() };
}

// ── 워커 전용 ────────────────────────────────────────────────────────

export class JobLostError extends Error {
  constructor() {
    super("JOB_LOST");
    this.name = "JobLostError";
  }
}

/** QUEUED → RUNNING (attempt+1). 다른 상태면 null (취소·중복 실행 방지) */
export async function claimReport(reportId: string): Promise<ReportRow | null> {
  const now = new Date();
  const rows = await getDb()
    .update(schema.report)
    .set({ status: "RUNNING", attemptCount: sql`${schema.report.attemptCount} + 1`, heartbeatAt: now, startedAt: sql`coalesce(${schema.report.startedAt}, ${now})`, progressStage: "LOAD", progressPct: 2, updatedAt: now })
    .where(and(eq(schema.report.id, reportId), eq(schema.report.status, "QUEUED")))
    .returning();
  return rows[0] ?? null;
}

/** 하트비트 + 진행률. 소유권(RUNNING & attempt 일치) 상실 시 JobLostError */
export async function heartbeat(reportId: string, attempt: number, progress?: { stage: string; pct: number; message: string }): Promise<void> {
  const rows = await getDb()
    .update(schema.report)
    .set({ heartbeatAt: new Date(), updatedAt: new Date(), ...(progress ? { progressStage: progress.stage, progressPct: Math.min(100, Math.max(0, Math.round(progress.pct))), progressMessage: progress.message.slice(0, 200) } : {}) })
    .where(and(eq(schema.report.id, reportId), eq(schema.report.status, "RUNNING"), eq(schema.report.attemptCount, attempt)))
    .returning({ id: schema.report.id });
  if (!rows[0]) throw new JobLostError();
}

export async function markSucceeded(reportId: string, attempt: number, content: ReportContent): Promise<void> {
  const rows = await getDb()
    .update(schema.report)
    .set({ status: "SUCCEEDED", schemaVersion: content.schemaVersion, contentJson: content, qualityJson: content.quality, resolvedFocus: content.meta.resolvedFocus, progressStage: "DONE", progressPct: 100, progressMessage: "보고 끝", finishedAt: new Date(), heartbeatAt: null, updatedAt: new Date() })
    .where(and(eq(schema.report.id, reportId), eq(schema.report.status, "RUNNING"), eq(schema.report.attemptCount, attempt)))
    .returning({ id: schema.report.id });
  if (!rows[0]) throw new JobLostError();
}

export async function markFailed(reportId: string, attempt: number, code: string, detail?: string): Promise<void> {
  const { message, retryable } = userMessageFor(code);
  await getDb()
    .update(schema.report)
    .set({ status: "FAILED", errorCode: code, errorMessage: message, errorRetryable: retryable, progressStage: "FAILED", finishedAt: new Date(), heartbeatAt: null, updatedAt: new Date() })
    .where(and(eq(schema.report.id, reportId), sql`${schema.report.status} IN ('RUNNING','QUEUED')`, eq(schema.report.attemptCount, attempt)));
  if (detail) console.warn(`[reports] ${reportId} failed ${code}: ${detail.slice(0, 300)}`);
}

export async function getStageResult<T>(requestKey: string): Promise<{ value: T; inputTokens: number; outputTokens: number; model: string } | null> {
  const rows = await getDb().select().from(schema.reportStageResult).where(eq(schema.reportStageResult.requestKey, requestKey)).limit(1);
  if (!rows[0]) return null;
  return { value: rows[0].resultJson as T, inputTokens: rows[0].inputTokens, outputTokens: rows[0].outputTokens, model: rows[0].model };
}

export async function saveStageResult(data: { reportId: string; stage: string; chunkIndex: number; requestKey: string; model: string; value: unknown; inputTokens: number; outputTokens: number }): Promise<void> {
  await getDb()
    .insert(schema.reportStageResult)
    .values({ reportId: data.reportId, stage: data.stage, chunkIndex: data.chunkIndex, requestKey: data.requestKey, model: data.model, resultJson: data.value, inputTokens: data.inputTokens, outputTokens: data.outputTokens })
    .onConflictDoNothing();
}

export async function logLlmCall(data: { reportId: string; stage: string; chunkIndex: number | null; model: string; requestKey: string; attempt: number; status: string; errorType?: string | null; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }; costUsd?: number; latencyMs?: number }): Promise<void> {
  await getDb().insert(schema.llmCallLog).values({
    reportId: data.reportId,
    stage: data.stage,
    chunkIndex: data.chunkIndex,
    model: data.model,
    requestKey: data.requestKey,
    attempt: data.attempt,
    status: data.status,
    errorType: data.errorType ?? null,
    inputTokens: data.usage?.input ?? null,
    outputTokens: data.usage?.output ?? null,
    cacheReadTokens: data.usage?.cacheRead ?? null,
    cacheWriteTokens: data.usage?.cacheWrite ?? null,
    costUsd: data.costUsd === undefined ? null : data.costUsd.toFixed(6),
    latencyMs: data.latencyMs ?? null,
  });
}

/** 하트비트가 끊긴 RUNNING 보고서 복구: attempt<max → QUEUED 재투입, 아니면 FAILED(STALE_TIMEOUT) */
/**
 * 워커가 종료(재시작·배포)될 때 자기가 처리 중이던 보고서를 즉시 QUEUED로 되돌린다.
 * 하트비트 타임아웃을 기다리지 않으므로 재배포 뒤 10분씩 멈춰 보이는 일이 없다. 잡은 비우고 다시 넣는다(실패하면 bootstrap 복구가 집어 간다).
 */
export async function requeueRunning(reportId: string, reason = "워커 재시작으로 다시 줄 서는 중"): Promise<boolean> {
  const db = getDb();
  const rows = await db.select().from(schema.report).where(and(eq(schema.report.id, reportId), eq(schema.report.status, "RUNNING"))).limit(1);
  const r = rows[0];
  if (!r) return false;
  const updated = await db
    .update(schema.report)
    .set({ status: "QUEUED", heartbeatAt: null, progressStage: "QUEUED", progressMessage: reason, updatedAt: new Date() })
    .where(and(eq(schema.report.id, reportId), eq(schema.report.status, "RUNNING"), eq(schema.report.attemptCount, r.attemptCount)))
    .returning({ id: schema.report.id });
  if (!updated[0]) return false;
  await releaseReportJob(r.jobId);
  try {
    const jobId = await enqueueReportJob(reportId, r.conversationId);
    await db.update(schema.report).set({ jobId: jobId ?? null }).where(eq(schema.report.id, reportId));
  } catch {
    /* 큐가 이미 닫혔으면 다음 워커의 bootstrap 복구(QUEUED + 잡 없음 → 즉시 재큐잉)가 처리 */
  }
  return true;
}

/**
 * 멈춘 보고서 복구 (워커 60초 주기 + 기동 직후 bootstrap).
 * - RUNNING인데 하트비트가 끊김(워커 사망·재시작): 옛 잡을 큐에서 비우고 QUEUED로 되돌려 다시 enqueue
 * - QUEUED인데 살아 있는 잡이 없음(싱글톤 충돌로 enqueue가 null이었거나 잡이 만료·삭제됨): 다시 enqueue
 * bootstrap=true면 직전 프로세스가 죽었다고 보고 하트비트 60초 이상 끊긴 RUNNING을 모두 복구한다(주기 하트비트는 30초).
 */
export async function recoverStaleReports(now = new Date(), opts: { bootstrap?: boolean } = {}): Promise<{ requeued: number; failed: number }> {
  const cfg = getConfig();
  const staleMs = opts.bootstrap ? 60_000 : cfg.WORKER_STALE_MINUTES * 60_000;
  const staleBefore = new Date(now.getTime() - staleMs);
  const db = getDb();
  let requeued = 0;
  let failed = 0;

  const requeue = async (r: ReportRow, fromStatus: "RUNNING" | "QUEUED") => {
    const rows = await db
      .update(schema.report)
      .set({ status: "QUEUED", heartbeatAt: null, progressStage: "QUEUED", progressMessage: fromStatus === "RUNNING" ? "연결이 끊겨 다시 줄 서는 중" : "다시 줄 서는 중", updatedAt: now })
      .where(and(eq(schema.report.id, r.id), eq(schema.report.status, fromStatus), eq(schema.report.attemptCount, r.attemptCount)))
      .returning({ id: schema.report.id });
    if (!rows[0]) return;
    await releaseReportJob(r.jobId);
    try {
      const jobId = await enqueueReportJob(r.id, r.conversationId);
      if (jobId) {
        await db.update(schema.report).set({ jobId }).where(eq(schema.report.id, r.id));
        requeued += 1;
      } else {
        await markFailed(r.id, r.attemptCount, "QUEUE_ERROR", "큐에 같은 대화의 잡이 남아 있어요 (singleton 충돌)");
        failed += 1;
      }
    } catch (e) {
      await markFailed(r.id, r.attemptCount, "QUEUE_ERROR", e instanceof Error ? e.message : String(e));
      failed += 1;
    }
  };

  const stale = await db.select().from(schema.report).where(and(eq(schema.report.status, "RUNNING"), lt(schema.report.heartbeatAt, staleBefore)));
  for (const r of stale) {
    if (r.attemptCount < cfg.WORKER_MAX_ATTEMPTS) await requeue(r, "RUNNING");
    else {
      await releaseReportJob(r.jobId);
      await markFailed(r.id, r.attemptCount, "STALE_TIMEOUT");
      failed += 1;
    }
  }

  // QUEUED인데 잡이 없거나 끝난 상태 (2분 이상 그대로일 때만; bootstrap이면 즉시)
  const queuedBefore = new Date(now.getTime() - (opts.bootstrap ? 0 : 2 * 60_000));
  const queued = await db.select().from(schema.report).where(and(eq(schema.report.status, "QUEUED"), lt(schema.report.updatedAt, queuedBefore)));
  for (const r of queued) {
    const state = await getReportJobState(r.jobId);
    if (state === "created" || state === "retry" || state === "active") continue;
    await requeue(r, "QUEUED");
  }
  return { requeued, failed };
}

/** 성공 보고서의 LLM 원출력 체크포인트는 24시간 뒤 삭제 (docs/05 §5) */
/** 체크포인트 정리. CHUNK 결과는 같은 대화의 다음 보고서가 재사용하므로 원문 보존 기간(RAW_RETENTION_DAYS)만큼 둔다 */
export async function cleanupStageResults(now = new Date()): Promise<number> {
  const cfg = getConfig();
  const before = new Date(now.getTime() - cfg.STAGE_RESULT_RETENTION_HOURS * 3600_000);
  const chunkBefore = new Date(now.getTime() - cfg.RAW_RETENTION_DAYS * 86_400_000);
  const rows = await getDb()
    .delete(schema.reportStageResult)
    .where(
      sql`(${schema.reportStageResult.stage} = 'CHUNK' AND ${schema.reportStageResult.createdAt} < ${chunkBefore})
        OR (${schema.reportStageResult.stage} <> 'CHUNK' AND ${schema.reportStageResult.createdAt} < ${before} AND ${schema.reportStageResult.reportId} IN (SELECT id FROM report WHERE status = 'SUCCEEDED'))`,
    )
    .returning({ id: schema.reportStageResult.id });
  return rows.length;
}

export { ApiError };
