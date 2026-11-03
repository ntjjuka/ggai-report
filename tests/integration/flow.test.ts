// 통합 테스트 (docs/11 §3): 실제 PostgreSQL(ggai_test) + FakeLlmClient
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeLlmClient } from "@/lib/llm";
import { closeDb, getDb, schema } from "@/server/db";
import { runMigrations } from "@/server/migrate";
import { REPORT_QUEUE, getBoss, stopBoss } from "@/server/queue";
import { confirmParticipants, deleteConversation, expireRawConversations, getConversationDetail, listOwnedConversations, uploadConversation } from "@/server/services/conversations";
import { cancelReport, claimReport, createReport, deleteReport, disableShare, enableShare, getReportBySeq, getSharedReport, markFailed, recoverStaleReports, requeueRunning, retryReport } from "@/server/services/reports";
import { runReport } from "@/worker/pipeline";

const OWNER = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);
const IP = "c".repeat(64);

function fixture(name: string) {
  return { name, bytes: new Uint8Array(readFileSync(join(process.cwd(), "docs", "fixtures", name))) };
}

async function truncateAll() {
  const db = getDb();
  await db.execute(sql`TRUNCATE conversation, audit_event, llm_call_log, report_stage_result CASCADE`);
}

describe("end-to-end service flow", () => {
  beforeAll(async () => {
    await runMigrations(process.env.DATABASE_URL!);
    await truncateAll();
  }, 120_000);

  afterAll(async () => {
    await stopBoss();
    await closeDb();
  });

  let conversationId = "";
  let uploaderId = "";
  let firstReportId = "";

  it("uploads, parses, builds tier0 story and dedupes re-upload", async () => {
    const { detail, reused } = await uploadConversation({ files: [fixture("android_ko_basic.txt")], ownerHash: OWNER, ipHash: IP, focus: "FRIENDS_GROUP" });
    expect(reused).toBe(false);
    expect(detail.sourceFormat).toBe("KAKAO_ANDROID_KO");
    expect(["EXCELLENT", "GOOD", "FAIR", "WEAK"]).toContain(detail.signal?.grade);
    expect(detail.signal?.reasons.length).toBeGreaterThan(0);
    expect(detail.participants.map((p) => p.rawName).sort()).toEqual(["김하늘", "박민수", "이서연"]);
    expect(detail.tier0?.story.map((c) => c.key)).toEqual(["overview", "who_more_who_first", "rhythm", "longest_messages", "first_day", "last_day", "frequent_words"]);
    expect(detail.tier0?.signal).toBe("WEAK");
    expect(detail.defaultFocus).toBe("FRIENDS_GROUP");
    expect(detail.rawAvailable).toBe(true);
    conversationId = detail.conversationId;
    uploaderId = detail.participants.find((p) => p.rawName === "박민수")!.participantId;

    const again = await uploadConversation({ files: [fixture("android_ko_basic.txt")], ownerHash: OWNER, ipHash: IP });
    expect(again.reused).toBe(true);
    expect(again.detail.conversationId).toBe(conversationId);

    const other = await uploadConversation({ files: [fixture("android_ko_basic.txt")], ownerHash: OTHER_OWNER, ipHash: IP });
    expect(other.reused).toBe(false);
    expect(other.detail.conversationId).not.toBe(conversationId);
  });

  it("hides conversations from other owners", async () => {
    await expect(getConversationDetail(conversationId, OTHER_OWNER)).rejects.toMatchObject({ status: 404 });
    const mine = await listOwnedConversations(OWNER);
    expect(mine.map((c) => c.conversationId)).toEqual([conversationId]);
    expect(mine[0].reports).toEqual([]);
    expect((await listOwnedConversations(OTHER_OWNER)).map((c) => c.conversationId)).not.toContain(conversationId); // 다른 소유자 목록에는 없다
  });

  it("confirms participants (uploader, exclude, rename) and recomputes stats", async () => {
    const detail = await getConversationDetail(conversationId, OWNER);
    const haneul = detail.participants.find((p) => p.rawName === "김하늘")!;
    const updated = await confirmParticipants(conversationId, OWNER, { uploaderParticipantId: uploaderId, merges: [], excluded: [haneul.participantId], displayNames: { [uploaderId]: "민수" }, title: "테스트 방" });
    expect(updated.uploaderParticipantId).toBe(uploaderId);
    expect(updated.effectiveParticipantCount).toBe(2);
    expect(updated.participants.find((p) => p.participantId === uploaderId)?.displayName).toBe("민수");
    expect(updated.title).toBe("테스트 방");
    await expect(confirmParticipants(conversationId, OWNER, { uploaderParticipantId: uploaderId, merges: [], excluded: [uploaderId], displayNames: {} })).rejects.toMatchObject({ status: 400 });
  });

  it("creates a report (QUEUED) and rejects a second active one", async () => {
    const view = await createReport(conversationId, OWNER, { focus: "FRIEND_ONE", focusQuestion: "얘 나한테 관심 있어?" });
    expect(view.status).toBe("QUEUED");
    expect(view.seq).toBe(1);
    firstReportId = view.reportId;
    await expect(createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null })).rejects.toMatchObject({ code: "REPORT_ALREADY_RUNNING" });
  });

  it("runs the pipeline with the fake LLM and produces a full report", async () => {
    const result = await runReport(firstReportId, { llm: new FakeLlmClient("ok") });
    expect(result).toBe("done");
    const view = await getReportBySeq(conversationId, 1, OWNER);
    expect(view.status).toBe("SUCCEEDED");
    const c = view.content!;
    expect(c.verdict.headline.length).toBeGreaterThan(0);
    expect(c.participants.length).toBe(2);
    expect(c.participants.some((p) => p.name === "민수" && p.isUploader)).toBe(true);
    expect(c.scores.length).toBe(5);
    expect(c.whatIWouldDo.length).toBe(3);
    expect(c.awards.length).toBeGreaterThanOrEqual(3);
    expect(c.findings.every((f) => f.evidence.every((e) => e.text.length > 0 && e.participantName.length > 0))).toBe(true);
    expect(c.answer?.question).toBe("얘 나한테 관심 있어?");
    expect(c.quality.mode).toBe("SINGLE");
    expect(c.quality.costUsd).toBeGreaterThanOrEqual(0);
    expect(view.options.resolvedFocus).toBe("FRIEND_ONE");
    const logs = await getDb().select().from(schema.llmCallLog);
    // 종합은 기본 두 갈래(장면·인물 / 판정·나머지)로 동시에 — 둘 다 OK로 기록되고 체크포인트도 둘
    expect(logs.filter((l) => l.stage.startsWith("SYNTHESIS") && l.status === "OK").map((l) => l.stage).sort()).toEqual(["SYNTHESIS_PERSONA", "SYNTHESIS_VERDICT"]);
    const stages = await getDb().select().from(schema.reportStageResult);
    expect(stages.filter((r) => r.stage.startsWith("SYNTHESIS")).length).toBe(2);
  });

  it("re-running a succeeded report is skipped (ownership)", async () => {
    expect(await runReport(firstReportId, { llm: new FakeLlmClient("ok") })).toBe("skipped");
  });

  it("auto-requeues a retryable failure, then the retry reuses checkpoints", async () => {
    const view = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    expect(view.seq).toBe(2);
    // 재시도 가능한 실패(429·네트워크 끊김 등)는 FAILED가 아니라 자동으로 다시 줄을 선다
    expect(await runReport(view.reportId, { llm: new FakeLlmClient("rate_limit") })).toBe("requeued");
    const queued = await getReportBySeq(conversationId, 2, OWNER);
    expect(queued.status).toBe("QUEUED");
    expect(queued.attemptCount).toBe(1);
    expect(queued.progress.message).toContain("다시 쓰는 중");
    expect(await runReport(view.reportId, { llm: new FakeLlmClient("ok") })).toBe("done");
    const ok = await getReportBySeq(conversationId, 2, OWNER);
    expect(ok.status).toBe("SUCCEEDED");
    expect(ok.attemptCount).toBe(2);
    expect(ok.content?.persona.name).toBeTruthy();
    expect(ok.content?.participants.every((p) => p.paragraphs.length >= 1)).toBe(true);
  });

  it("marks FAILED (retryable) once automatic retries are exhausted, and manual retry is then refused", async () => {
    const view = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    expect(await runReport(view.reportId, { llm: new FakeLlmClient("rate_limit") })).toBe("requeued");
    expect(await runReport(view.reportId, { llm: new FakeLlmClient("rate_limit") })).toBe("requeued");
    expect(await runReport(view.reportId, { llm: new FakeLlmClient("rate_limit") })).toBe("failed");
    const failed = await getReportBySeq(conversationId, view.seq, OWNER);
    expect(failed.status).toBe("FAILED");
    expect(failed.attemptCount).toBe(3);
    expect(failed.error?.code).toBe("LLM_UNAVAILABLE");
    expect(failed.error?.retryable).toBe(true);
    await expect(retryReport(view.reportId, OWNER)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await deleteReport(view.reportId, OWNER);
  });

  it("hallucinated ids are dropped and counted; non-korean output is repaired", async () => {
    const v = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    expect(await runReport(v.reportId, { llm: new FakeLlmClient("hallucinate_ids") })).toBe("done");
    const r = await getReportBySeq(conversationId, v.seq, OWNER);
    expect(r.content?.quality.evidence.dropped).toBeGreaterThanOrEqual(1);
    const v2 = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    expect(await runReport(v2.reportId, { llm: new FakeLlmClient("hanja") })).toBe("done");
    const r2 = await getReportBySeq(conversationId, v2.seq, OWNER);
    const text = JSON.stringify(r2.content);
    expect(text).not.toMatch(/[一-鿿]/);
    expect(r2.content?.quality.repaired).toBe(true);
  });

  it("cancels a queued report and the worker skips it", async () => {
    const v = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    const canceled = await cancelReport(v.reportId, OWNER);
    expect(canceled.status).toBe("CANCELED");
    expect(await runReport(v.reportId, { llm: new FakeLlmClient("ok") })).toBe("skipped");
    await expect(cancelReport(v.reportId, OWNER)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("recovers stale RUNNING reports", async () => {
    const v = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    const claimed = await claimReport(v.reportId);
    expect(claimed?.status).toBe("RUNNING");
    await getDb().execute(sql`UPDATE report SET heartbeat_at = now() - interval '10 minutes' WHERE id = ${v.reportId}`);
    const r = await recoverStaleReports();
    expect(r.requeued).toBe(1);
    const view = await getReportBySeq(conversationId, v.seq, OWNER);
    expect(view.status).toBe("QUEUED");
    expect(await runReport(v.reportId, { llm: new FakeLlmClient("ok") })).toBe("done");
  });

  it("shares and unshares a report", async () => {
    const { url, token } = await enableShare(firstReportId, OWNER);
    expect(url).toContain("/r/");
    const shared = await getSharedReport(token);
    expect(shared.content.verdict.headline.length).toBeGreaterThan(0);
    await disableShare(firstReportId, OWNER);
    await expect(getSharedReport(token)).rejects.toMatchObject({ status: 404 });
    await expect(enableShare(firstReportId, OTHER_OWNER)).rejects.toMatchObject({ status: 404 });
  });

  it("deletes a single report, but not while it is queued or running", async () => {
    const v = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    await expect(deleteReport(v.reportId, OWNER)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await cancelReport(v.reportId, OWNER);
    await expect(deleteReport(v.reportId, OTHER_OWNER)).rejects.toMatchObject({ status: 404 });
    await deleteReport(v.reportId, OWNER);
    await expect(getReportBySeq(conversationId, v.seq, OWNER)).rejects.toMatchObject({ status: 404 });
    const first = await getReportBySeq(conversationId, 1, OWNER);
    expect(first.status).toBe("SUCCEEDED"); // 다른 보고서는 남는다
    const events = await getDb().select().from(schema.auditEvent);
    expect(events.some((e) => e.eventType === "REPORT_DELETE")).toBe(true);
  });

  it("bootstrap recovery re-enqueues a QUEUED report whose queue job is gone", async () => {
    const v = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    const before = (await getDb().select().from(schema.report).where(sql`id = ${v.reportId}`))[0];
    expect(before.jobId).toBeTruthy();
    const boss = await getBoss();
    await boss.deleteJob(REPORT_QUEUE, before.jobId!); // 잡이 사라진 QUEUED (싱글톤 충돌·만료 상황 재현)
    const r = await recoverStaleReports(new Date(), { bootstrap: true });
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    const after = (await getDb().select().from(schema.report).where(sql`id = ${v.reportId}`))[0];
    expect(after.status).toBe("QUEUED");
    expect(after.jobId).toBeTruthy();
    expect(after.jobId).not.toBe(before.jobId);
    await cancelReport(v.reportId, OWNER);
  });

  it("creating a report releases a dead worker's leftover active job (singleton conflict)", async () => {
    const v = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    const boss = await getBoss();
    const fetched = await boss.fetch(REPORT_QUEUE); // 워커처럼 잡을 가져가 active 로 만든다
    expect(fetched?.length ?? 0).toBeGreaterThanOrEqual(1);
    await claimReport(v.reportId);
    await markFailed(v.reportId, 1, "LLM_BAD_REQUEST"); // 보고서는 끝났지만 잡은 active 로 남음 (워커 사망 재현)
    const next = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    expect(next.status).toBe("QUEUED");
    const row = (await getDb().select().from(schema.report).where(sql`id = ${next.reportId}`))[0];
    expect(row.jobId).toBeTruthy();
    await cancelReport(next.reportId, OWNER);
  });

  it("creating a report heals a dead RUNNING report (stale heartbeat) instead of 409", async () => {
    const v = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    await claimReport(v.reportId);
    await getDb().execute(sql`UPDATE report SET heartbeat_at = now() - interval '30 minutes' WHERE id = ${v.reportId}`);
    await expect(createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null })).resolves.toMatchObject({ status: "QUEUED" });
    const old = await getReportBySeq(conversationId, v.seq, OWNER);
    expect(old.status).toBe("FAILED");
    expect(old.error?.code).toBe("STALE_TIMEOUT");
    expect(old.error?.retryable).toBe(true);
    const detail = await getConversationDetail(conversationId, OWNER);
    const active = detail.reports.filter((r) => r.status === "QUEUED" || r.status === "RUNNING");
    expect(active.length).toBe(1);
    await cancelReport(active[0].reportId, OWNER);
    // 살아 있는(하트비트 최근) RUNNING은 그대로 409
    const w = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    await claimReport(w.reportId);
    await expect(createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null })).rejects.toMatchObject({ code: "REPORT_ALREADY_RUNNING" });
    await cancelReport(w.reportId, OWNER);
  });

  it("requeues a RUNNING report immediately on worker shutdown (requeueRunning)", async () => {
    const v = await createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null });
    await claimReport(v.reportId);
    expect(await requeueRunning(v.reportId)).toBe(true);
    const row = await getReportBySeq(conversationId, v.seq, OWNER);
    expect(row.status).toBe("QUEUED");
    expect(row.progress.message).toContain("다시 줄 서는 중");
    expect(await requeueRunning(v.reportId)).toBe(false); // 이미 QUEUED
    await cancelReport(v.reportId, OWNER);
  });

  it("expires raw text and blocks new reports afterwards", async () => {
    await getDb().execute(sql`UPDATE conversation SET expires_at = now() - interval '1 day' WHERE id = ${conversationId}`);
    expect(await expireRawConversations()).toBe(1);
    const detail = await getConversationDetail(conversationId, OWNER);
    expect(detail.rawAvailable).toBe(false);
    expect(detail.status).toBe("RAW_EXPIRED");
    const old = await getReportBySeq(conversationId, 1, OWNER);
    expect(old.status).toBe("SUCCEEDED"); // 기존 보고서는 열림
    await expect(createReport(conversationId, OWNER, { focus: "AUTO", focusQuestion: null })).rejects.toMatchObject({ code: "RAW_EXPIRED" });
  });

  it("deletes everything with cascade", async () => {
    await deleteConversation(conversationId, OWNER);
    await expect(getConversationDetail(conversationId, OWNER)).rejects.toMatchObject({ status: 404 });
    const reports = await getDb().select().from(schema.report);
    expect(reports.every((r) => r.conversationId !== conversationId)).toBe(true);
    const stage = await getDb().select().from(schema.reportStageResult);
    expect(stage.every((s) => s.reportId !== firstReportId)).toBe(true);
  });
});
