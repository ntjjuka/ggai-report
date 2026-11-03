// drizzle 스키마 — db/migrations/0001_init.sql 과 1:1. 마이그레이션은 SQL 파일이 정본.
import { bigint, bigserial, boolean, char, customType, integer, jsonb, numeric, pgTable, smallint, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import type { ParseWarnings } from "@/lib/parser/types";
import type { ChatStats } from "@/lib/stats/types";
import type { Tier0Report } from "@/lib/tier0";
import type { ReportContent } from "@/lib/report/schema";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const local = (name: string) => timestamp(name, { mode: "string" });

export const conversation = pgTable("conversation", {
  id: uuid("id").primaryKey(),
  ownerTokenHash: char("owner_token_hash", { length: 64 }).notNull(),
  title: varchar("title", { length: 200 }),
  platform: varchar("platform", { length: 20 }).notNull().default("KAKAO"),
  sourceFormat: varchar("source_format", { length: 30 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  rawSha256: char("raw_sha256", { length: 64 }).notNull(),
  rawSizeBytes: bigint("raw_size_bytes", { mode: "number" }).notNull(),
  rawCipher: bytea("raw_cipher"),
  rawKeyId: varchar("raw_key_id", { length: 20 }),
  messageCount: integer("message_count").notNull(),
  textMessageCount: integer("text_message_count").notNull(),
  participantCount: integer("participant_count").notNull(),
  startedAt: local("started_at").notNull(),
  endedAt: local("ended_at").notNull(),
  parseWarnings: jsonb("parse_warnings").$type<ParseWarnings>().notNull(),
  tier0Json: jsonb("tier0_json").$type<Tier0Report>(),
  defaultFocus: varchar("default_focus", { length: 20 }).notNull().default("AUTO"),
  mergeSuggestions: jsonb("merge_suggestions").$type<{ from: string; into: string; confidence: number }[]>().notNull().default([]),
  uploaderParticipantId: uuid("uploader_participant_id"),
  participantsConfirmedAt: tz("participants_confirmed_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  expiresAt: tz("expires_at").notNull(),
});

export const participant = pgTable("participant", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  rawName: varchar("raw_name", { length: 100 }).notNull(),
  displayName: varchar("display_name", { length: 100 }).notNull(),
  mergedIntoId: uuid("merged_into_id"),
  excluded: boolean("excluded").notNull().default(false),
  isBot: boolean("is_bot").notNull().default(false),
  messageCount: integer("message_count").notNull(),
  firstAt: local("first_at").notNull(),
  lastAt: local("last_at").notNull(),
  position: integer("position").notNull(),
});

export const conversationStats = pgTable("conversation_stats", {
  conversationId: uuid("conversation_id").primaryKey(),
  statsVersion: integer("stats_version").notNull(),
  statsJson: jsonb("stats_json").$type<ChatStats>().notNull(),
  computedAt: tz("computed_at").notNull().defaultNow(),
});

export interface ParticipantSnapshotEntry {
  id: string;
  name: string;
  rawNames: string[];
  isUploader: boolean;
}

export const report = pgTable("report", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  seq: integer("seq").notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  focus: varchar("focus", { length: 20 }).notNull(),
  resolvedFocus: varchar("resolved_focus", { length: 20 }),
  tone: varchar("tone", { length: 10 }).notNull(),
  focusQuestion: varchar("focus_question", { length: 300 }),
  reportLanguage: varchar("report_language", { length: 8 }).notNull().default("ko"),
  visibility: varchar("visibility", { length: 10 }).notNull().default("FULL"),
  personaName: varchar("persona_name", { length: 30 }).notNull(),
  participantSnapshot: jsonb("participant_snapshot").$type<ParticipantSnapshotEntry[]>().notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  jobId: varchar("job_id", { length: 64 }),
  heartbeatAt: tz("heartbeat_at"),
  startedAt: tz("started_at"),
  finishedAt: tz("finished_at"),
  progressStage: varchar("progress_stage", { length: 30 }),
  progressPct: smallint("progress_pct").notNull().default(0),
  progressMessage: varchar("progress_message", { length: 200 }),
  schemaVersion: integer("schema_version"),
  contentJson: jsonb("content_json").$type<ReportContent>(),
  qualityJson: jsonb("quality_json").$type<ReportContent["quality"]>(),
  errorCode: varchar("error_code", { length: 50 }),
  errorMessage: varchar("error_message", { length: 500 }),
  errorRetryable: boolean("error_retryable"),
  shareTokenHash: char("share_token_hash", { length: 64 }),
  shareEnabled: boolean("share_enabled").notNull().default(false),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export const reportStageResult = pgTable("report_stage_result", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  reportId: uuid("report_id").notNull(),
  stage: varchar("stage", { length: 20 }).notNull(),
  chunkIndex: integer("chunk_index").notNull().default(-1),
  requestKey: char("request_key", { length: 64 }).notNull(),
  model: varchar("model", { length: 50 }).notNull(),
  resultJson: jsonb("result_json").$type<unknown>().notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const llmCallLog = pgTable("llm_call_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  reportId: uuid("report_id"),
  stage: varchar("stage", { length: 20 }).notNull(),
  chunkIndex: integer("chunk_index"),
  model: varchar("model", { length: 50 }).notNull(),
  requestKey: char("request_key", { length: 64 }).notNull(),
  attempt: smallint("attempt").notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  errorType: varchar("error_type", { length: 50 }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  latencyMs: integer("latency_ms"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const auditEvent = pgTable("audit_event", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  eventType: varchar("event_type", { length: 40 }).notNull(),
  conversationId: uuid("conversation_id"),
  reportId: uuid("report_id"),
  ipHash: char("ip_hash", { length: 64 }),
  ownerHash: char("owner_hash", { length: 64 }),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export type ConversationRow = typeof conversation.$inferSelect;
export type ParticipantRow = typeof participant.$inferSelect;
export type ReportRow = typeof report.$inferSelect;
