// 대화(업로드) 서비스 — docs/06 §1, docs/02 §3.1~3.2
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { decodeUploads, parseTexts, ParseError, type Message, type NamedBytes, type NamedText, type ParsedChat } from "@/lib/parser";
import { computeStats, type ChatStats, type ParticipantMap } from "@/lib/stats";
import { isBotSender } from "@/lib/parser/patterns";
import { buildTier0, type SignalInfo, type Tier0Report } from "@/lib/tier0";
import { getConfig } from "../config";
import { decryptRaw, encryptRaw, sha256Hex } from "../crypto";
import { getDb, schema } from "../db";
import { ApiError, conflict, notFound } from "../errors";
import { assertUploadAllowed, audit } from "../ratelimit";
import type { ConversationRow, ParticipantRow } from "../schema";
import { buildParticipantMap, suggestMerges, type MergeSuggestion } from "./participants";
import { listReportSummaries, type ReportSummary } from "./reports";

export interface ParticipantView {
  participantId: string;
  rawName: string;
  displayName: string;
  messageCount: number;
  firstAt: string;
  lastAt: string;
  isBot: boolean;
  excluded: boolean;
  mergedIntoId: string | null;
  isUploader: boolean;
}

export interface ConversationDetail {
  conversationId: string;
  title: string | null;
  sourceFormat: string;
  status: string;
  messageCount: number;
  textMessageCount: number;
  participantCount: number;
  startedAt: string;
  endedAt: string;
  participants: ParticipantView[];
  suggestedMerges: MergeSuggestion[];
  warnings: string[];
  uploaderParticipantId: string | null;
  participantsConfirmedAt: string | null;
  rawAvailable: boolean;
  rawExpiresAt: string;
  effectiveParticipantCount: number;
  /** docs/18 P0-5 — 업로드 직후 카드용 신호 등급 (tier0와 같은 등급) */
  signal: SignalInfo | null;
  tier0: Tier0Report | null;
  defaultFocus: string;
  reports: ReportSummary[];
  createdAt: string;
}

function warningsToList(w: ParsedChat["warnings"]): string[] {
  const out: string[] = [];
  if (w.encodingFallback) out.push("ENCODING_FALLBACK_CP949");
  if (w.nonMonotonicTimestamp) out.push(`NON_MONOTONIC_TIMESTAMP:${w.nonMonotonicTimestamp}`);
  if (w.dedupedCount) out.push(`DEDUPED:${w.dedupedCount}`);
  if (w.orphanLines) out.push(`ORPHAN_LINES:${w.orphanLines}`);
  if (w.unknownSystemLines) out.push(`UNKNOWN_SYSTEM_LINES:${w.unknownSystemLines}`);
  if (w.dateUnknownBeforeSeparator) out.push(`DATE_UNKNOWN_BEFORE_SEPARATOR:${w.dateUnknownBeforeSeparator}`);
  return out;
}

function limitsFromConfig() {
  const c = getConfig();
  return { maxMessages: c.UPLOAD_MAX_MESSAGES, minMessages: c.UPLOAD_MIN_MESSAGES, maxParticipants: c.UPLOAD_MAX_PARTICIPANTS };
}

/** 저장된 원문(암호화된 NamedText[] JSON)을 복호화해 다시 파싱한다. 결정적이므로 index 가 보존된다. */
export function parseStoredRaw(row: Pick<ConversationRow, "id" | "rawCipher">): ParsedChat {
  if (!row.rawCipher) throw conflict("RAW_EXPIRED", "원문 보관 기간이 지나 다시 분석할 수 없어요");
  const texts = JSON.parse(decryptRaw(row.rawCipher, row.id).toString("utf8")) as NamedText[];
  return parseTexts(texts, { ...limitsFromConfig(), minMessages: 1 });
}

export interface UploadInput {
  files: NamedBytes[];
  ownerHash: string;
  ipHash: string;
  title?: string | null;
  focus?: string | null;
}

export async function uploadConversation(input: UploadInput): Promise<{ detail: ConversationDetail; reused: boolean }> {
  const cfg = getConfig();
  await assertUploadAllowed(input.ipHash, cfg.LIMIT_UPLOADS_PER_IP_PER_HOUR);
  const totalBytes = input.files.reduce((a, f) => a + f.bytes.byteLength, 0);
  if (totalBytes > cfg.UPLOAD_MAX_BYTES) throw new ParseError("FILE_TOO_LARGE");
  if (input.files.length === 0 || input.files.length > 20) throw new ApiError(400, "VALIDATION_FAILED", "파일은 1~20개까지 올릴 수 있어요", [{ field: "files", reason: "1~20개" }]);

  const { texts, encodingFallback } = decodeUploads(input.files);
  const rawJson = JSON.stringify(texts);
  const rawSha = sha256Hex(rawJson);
  const db = getDb();

  const existing = await db.select({ id: schema.conversation.id }).from(schema.conversation).where(and(eq(schema.conversation.ownerTokenHash, input.ownerHash), eq(schema.conversation.rawSha256, rawSha))).limit(1);
  if (existing[0]) {
    const detail = await getConversationDetail(existing[0].id, input.ownerHash);
    return { detail, reused: true };
  }

  const chat = parseTexts(texts, limitsFromConfig(), encodingFallback);
  const conversationId = randomUUID();
  const rows: ParticipantRow[] = chat.participants.map((p, i) => ({
    id: randomUUID(),
    conversationId,
    rawName: p.rawName,
    displayName: p.rawName,
    mergedIntoId: null,
    excluded: false,
    isBot: isBotSender(p.rawName),
    messageCount: p.messageCount,
    firstAt: p.firstAt,
    lastAt: p.lastAt,
    position: i,
  }));
  const map = buildParticipantMap(rows, null);
  const stats = computeStats(chat.messages, map, null);
  const tier0 = buildTier0(stats, chat.messages, conversationId);
  const merges = suggestMerges(chat.messages, rows);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + cfg.RAW_RETENTION_DAYS * 86_400_000);

  await db.transaction(async (tx) => {
    await tx.insert(schema.conversation).values({
      id: conversationId,
      ownerTokenHash: input.ownerHash,
      title: (input.title?.trim() || chat.title || null)?.slice(0, 200) ?? null,
      platform: "KAKAO",
      sourceFormat: chat.sourceFormat,
      status: "READY",
      rawSha256: rawSha,
      rawSizeBytes: Buffer.byteLength(rawJson, "utf8"),
      rawCipher: encryptRaw(Buffer.from(rawJson, "utf8"), conversationId),
      rawKeyId: cfg.APP_CRYPTO_KEY_ID,
      messageCount: chat.messageCount,
      textMessageCount: stats.total.textMessages,
      participantCount: rows.filter((r) => !r.isBot).length,
      startedAt: chat.messages[0].at,
      endedAt: chat.messages[chat.messages.length - 1].at,
      parseWarnings: chat.warnings,
      tier0Json: tier0,
      mergeSuggestions: merges,
      defaultFocus: input.focus ?? "AUTO",
      expiresAt,
    });
    if (rows.length) await tx.insert(schema.participant).values(rows);
    await tx.insert(schema.conversationStats).values({ conversationId, statsVersion: stats.statsVersion, statsJson: stats });
  });
  await audit("UPLOAD", { conversationId, ipHash: input.ipHash, ownerHash: input.ownerHash });
  const detail = await getConversationDetail(conversationId, input.ownerHash);
  return { detail, reused: false };
}

export async function findOwnedConversation(id: string, ownerHash: string): Promise<ConversationRow> {
  const rows = await getDb().select().from(schema.conversation).where(and(eq(schema.conversation.id, id), eq(schema.conversation.ownerTokenHash, ownerHash))).limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

export async function listParticipants(conversationId: string): Promise<ParticipantRow[]> {
  return getDb().select().from(schema.participant).where(eq(schema.participant.conversationId, conversationId)).orderBy(asc(schema.participant.position));
}

export async function getConversationDetail(id: string, ownerHash: string): Promise<ConversationDetail> {
  const row = await findOwnedConversation(id, ownerHash);
  return toDetail(row, await listParticipants(id), await listReportSummaries(id));
}

function toDetail(row: ConversationRow, parts: ParticipantRow[], reports: ReportSummary[]): ConversationDetail {
  const map = buildParticipantMap(parts, row.uploaderParticipantId);
  const effective = new Set([...map.values()].map((p) => p.id));
  return {
    conversationId: row.id,
    title: row.title,
    sourceFormat: row.sourceFormat,
    status: row.status,
    messageCount: row.messageCount,
    textMessageCount: row.textMessageCount,
    participantCount: row.participantCount,
    startedAt: row.startedAt.replace(" ", "T").slice(0, 16),
    endedAt: row.endedAt.replace(" ", "T").slice(0, 16),
    participants: parts.map((p) => ({
      participantId: p.id,
      rawName: p.rawName,
      displayName: p.displayName,
      messageCount: p.messageCount,
      firstAt: p.firstAt.replace(" ", "T").slice(0, 16),
      lastAt: p.lastAt.replace(" ", "T").slice(0, 16),
      isBot: p.isBot,
      excluded: p.excluded,
      mergedIntoId: p.mergedIntoId,
      isUploader: p.id === row.uploaderParticipantId,
    })),
    suggestedMerges: row.participantsConfirmedAt ? [] : row.mergeSuggestions,
    warnings: warningsToList(row.parseWarnings),
    uploaderParticipantId: row.uploaderParticipantId,
    participantsConfirmedAt: row.participantsConfirmedAt?.toISOString() ?? null,
    rawAvailable: row.rawCipher !== null && row.status !== "RAW_EXPIRED",
    rawExpiresAt: row.expiresAt.toISOString(),
    effectiveParticipantCount: effective.size,
    signal: row.tier0Json ? { grade: row.tier0Json.signal, label: row.tier0Json.signalLabel, reasons: (row.tier0Json as Partial<Tier0Report>).signalReasons ?? [] } : null,
    tier0: row.tier0Json ?? null,
    defaultFocus: row.defaultFocus,
    reports,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ConfirmCommand {
  uploaderParticipantId: string | null;
  merges: { from: string; into: string }[];
  excluded: string[];
  displayNames: Record<string, string>;
  title?: string;
}

export async function confirmParticipants(id: string, ownerHash: string, cmd: ConfirmCommand): Promise<ConversationDetail> {
  const row = await findOwnedConversation(id, ownerHash);
  const parts = await listParticipants(id);
  const byId = new Map(parts.map((p) => [p.id, p]));
  const fieldErrors: { field: string; reason: string }[] = [];
  if (cmd.uploaderParticipantId && !byId.has(cmd.uploaderParticipantId)) fieldErrors.push({ field: "uploaderParticipantId", reason: "이 대화의 참여자가 아니에요" });
  const excluded = new Set(cmd.excluded);
  const mergeFrom = new Map<string, string>();
  for (const m of cmd.merges) {
    if (!byId.has(m.from) || !byId.has(m.into)) fieldErrors.push({ field: "merges", reason: "참여자 ID가 올바르지 않아요" });
    else if (m.from === m.into) fieldErrors.push({ field: "merges", reason: "자기 자신과 병합할 수 없어요" });
    else mergeFrom.set(m.from, m.into);
  }
  for (const [from, into] of mergeFrom) {
    if (mergeFrom.has(into)) fieldErrors.push({ field: "merges", reason: `MERGE_CHAIN: ${from}→${into}→${mergeFrom.get(into)}` });
  }
  if (cmd.uploaderParticipantId && (excluded.has(cmd.uploaderParticipantId) || mergeFrom.has(cmd.uploaderParticipantId))) fieldErrors.push({ field: "uploaderParticipantId", reason: "업로더는 제외·병합할 수 없어요" });
  for (const [pid, name] of Object.entries(cmd.displayNames)) {
    if (!byId.has(pid)) fieldErrors.push({ field: `displayNames.${pid}`, reason: "참여자 ID가 올바르지 않아요" });
    if (!name.trim() || name.length > 100) fieldErrors.push({ field: `displayNames.${pid}`, reason: "1~100자" });
  }
  if (fieldErrors.length) throw new ApiError(400, "VALIDATION_FAILED", "참여자 설정을 확인해 주세요", fieldErrors);

  const updated: ParticipantRow[] = parts.map((p) => ({
    ...p,
    excluded: excluded.has(p.id),
    mergedIntoId: mergeFrom.get(p.id) ?? null,
    displayName: cmd.displayNames[p.id]?.trim() || p.displayName,
  }));
  const map = buildParticipantMap(updated, cmd.uploaderParticipantId);
  const effectiveCount = new Set([...map.values()].map((p) => p.id)).size;
  if (effectiveCount < 2) throw conflict("NOT_ENOUGH_PARTICIPANTS", "분석할 참여자가 2명 이상 필요해요");

  // 통계·Tier0 재계산 (원문 필요; 만료면 기존 유지)
  let stats: ChatStats | null = null;
  let tier0: Tier0Report | null = null;
  if (row.rawCipher) {
    const chat = parseStoredRaw(row);
    stats = computeStats(chat.messages, map, cmd.uploaderParticipantId);
    tier0 = buildTier0(stats, chat.messages, row.id);
  }
  await getDb().transaction(async (tx) => {
    for (const p of updated) {
      await tx.update(schema.participant).set({ excluded: p.excluded, mergedIntoId: p.mergedIntoId, displayName: p.displayName }).where(eq(schema.participant.id, p.id));
    }
    await tx
      .update(schema.conversation)
      .set({ uploaderParticipantId: cmd.uploaderParticipantId, participantsConfirmedAt: new Date(), updatedAt: new Date(), ...(tier0 ? { tier0Json: tier0 } : {}), ...(cmd.title?.trim() ? { title: cmd.title.trim().slice(0, 200) } : {}) })
      .where(eq(schema.conversation.id, id));
    if (stats) await tx.update(schema.conversationStats).set({ statsJson: stats, statsVersion: stats.statsVersion, computedAt: new Date() }).where(eq(schema.conversationStats.conversationId, id));
  });
  return getConversationDetail(id, ownerHash);
}

export async function getStats(id: string, ownerHash: string): Promise<ChatStats> {
  await findOwnedConversation(id, ownerHash);
  const rows = await getDb().select().from(schema.conversationStats).where(eq(schema.conversationStats.conversationId, id)).limit(1);
  if (!rows[0]) throw notFound();
  return rows[0].statsJson;
}

export async function deleteConversation(id: string, ownerHash: string): Promise<void> {
  await findOwnedConversation(id, ownerHash);
  const db = getDb();
  // 실행 중 보고서는 먼저 취소 처리(워커가 소유권 상실로 중단)
  await db.update(schema.report).set({ status: "CANCELED", finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(schema.report.conversationId, id), sql`${schema.report.status} IN ('QUEUED','RUNNING')`));
  await db.delete(schema.conversation).where(eq(schema.conversation.id, id));
  await audit("DELETE", { conversationId: id, ownerHash });
}

/** 보관 기간이 지난 원문 삭제 (워커 스케줄) */
export async function expireRawConversations(now = new Date()): Promise<number> {
  const db = getDb();
  const rows = await db
    .update(schema.conversation)
    .set({ rawCipher: null, status: "RAW_EXPIRED", updatedAt: now })
    .where(and(isNotNull(schema.conversation.rawCipher), lt(schema.conversation.expiresAt, now)))
    .returning({ id: schema.conversation.id });
  for (const r of rows) await audit("RAW_EXPIRE", { conversationId: r.id });
  return rows.length;
}

export async function loadMessagesForReport(conversationId: string): Promise<{ row: ConversationRow; messages: Message[] }> {
  const rows = await getDb().select().from(schema.conversation).where(eq(schema.conversation.id, conversationId)).limit(1);
  if (!rows[0]) throw notFound();
  const chat = parseStoredRaw(rows[0]);
  return { row: rows[0], messages: chat.messages };
}

export function effectiveMapOf(parts: ParticipantRow[], uploaderId: string | null): ParticipantMap {
  return buildParticipantMap(parts, uploaderId);
}

export { desc };
