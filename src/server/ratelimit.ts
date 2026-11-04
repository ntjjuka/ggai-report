// DB 기반 레이트리밋 (docs/06 §4) — audit_event 카운트. 다중 인스턴스에서도 일관.
import { and, eq, gt, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { ApiError } from "./errors";

async function countSince(eventType: string, column: "ipHash" | "ownerHash", value: string, since: Date): Promise<number> {
  const db = getDb();
  const col = column === "ipHash" ? schema.auditEvent.ipHash : schema.auditEvent.ownerHash;
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.auditEvent)
    .where(and(eq(schema.auditEvent.eventType, eventType), eq(col, value), gt(schema.auditEvent.createdAt, since)));
  return rows[0]?.n ?? 0;
}

export async function assertUploadAllowed(ipHash: string, limitPerHour: number): Promise<void> {
  const n = await countSince("UPLOAD", "ipHash", ipHash, new Date(Date.now() - 3600_000));
  if (n >= limitPerHour) throw new ApiError(429, "RATE_LIMITED", "업로드가 너무 잦아요. 1시간 뒤 다시 시도해 주세요", [], { "Retry-After": "3600" });
}

export async function assertReportAllowed(ownerHash: string, limitPerDay: number): Promise<void> {
  const n = await countSince("REPORT_CREATE", "ownerHash", ownerHash, new Date(Date.now() - 86_400_000));
  if (n >= limitPerDay) throw new ApiError(429, "RATE_LIMITED", "오늘 만들 수 있는 보고서 수를 넘었어요. 내일 다시 시도해 주세요", [], { "Retry-After": "86400" });
}

export async function audit(eventType: string, data: { conversationId?: string | null; reportId?: string | null; ipHash?: string | null; ownerHash?: string | null }): Promise<void> {
  await getDb().insert(schema.auditEvent).values({
    eventType,
    conversationId: data.conversationId ?? null,
    reportId: data.reportId ?? null,
    ipHash: data.ipHash ?? null,
    ownerHash: data.ownerHash ?? null,
  });
}
