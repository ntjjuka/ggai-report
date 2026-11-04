// pg-boss 큐 (docs/15 §A.3). 대화당 실행 1개는 stately 정책 + singletonKey(conversationId) + DB 부분 유니크 인덱스로 이중 방어.
import { PgBoss } from "pg-boss";
import { getConfig } from "./config";

export const REPORT_QUEUE = "report-generate";
export interface ReportJobData {
  reportId: string;
}

let bossPromise: Promise<PgBoss> | null = null;

export function getBoss(role: "web" | "worker" = "web"): Promise<PgBoss> {
  if (!bossPromise) {
    bossPromise = (async () => {
      const boss = new PgBoss({
        connectionString: getConfig().DATABASE_URL,
        schema: "pgboss",
        supervise: role === "worker",
        schedule: false,
        max: role === "worker" ? 5 : 2,
      });
      boss.on("error", (e: unknown) => console.error("[queue] error:", e instanceof Error ? e.message : String(e)));
      await boss.start();
      try {
        await boss.createQueue(REPORT_QUEUE, {
          policy: "stately",
          retryLimit: 0,
          expireInSeconds: 60 * getConfig().WORKER_PIPELINE_TIMEOUT_MINUTES + 300,
        });
      } catch (e) {
        // 이미 존재하면 무시
        if (!/exist/i.test(e instanceof Error ? e.message : String(e))) throw e;
      }
      return boss;
    })();
    bossPromise.catch(() => {
      bossPromise = null;
    });
  }
  return bossPromise;
}

export async function enqueueReportJob(reportId: string, conversationId: string, opts: { startAfterSec?: number } = {}): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(REPORT_QUEUE, { reportId } satisfies ReportJobData, { singletonKey: conversationId, ...(opts.startAfterSec ? { startAfter: opts.startAfterSec } : {}) });
}

export async function cancelReportJob(jobId: string | null): Promise<void> {
  if (!jobId) return;
  try {
    const boss = await getBoss();
    await boss.cancel(REPORT_QUEUE, jobId);
  } catch (e) {
    console.warn("[queue] cancel failed:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * 잡을 큐에서 완전히 비운다 (취소 후 삭제). stately 정책은 같은 singletonKey(conversationId)의 잡이
 * created/retry/active 상태면 새 잡을 받지 않으므로, 죽은 워커가 남긴 active 잡을 치워야 재큐잉·새 보고서가 가능하다.
 */
export async function releaseReportJob(jobId: string | null): Promise<void> {
  if (!jobId) return;
  try {
    const boss = await getBoss();
    await boss.cancel(REPORT_QUEUE, jobId).catch(() => undefined);
    await boss.deleteJob(REPORT_QUEUE, jobId);
  } catch (e) {
    console.warn("[queue] release failed:", e instanceof Error ? e.message : String(e));
  }
}

/** 잡 상태. 없으면 null */
export async function getReportJobState(jobId: string | null): Promise<string | null> {
  if (!jobId) return null;
  try {
    const boss = await getBoss();
    const job = await boss.getJobById(REPORT_QUEUE, jobId);
    return job?.state ?? null;
  } catch (e) {
    console.warn("[queue] getJobById failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

export async function stopBoss(): Promise<void> {
  if (!bossPromise) return;
  const boss = await bossPromise;
  bossPromise = null;
  await boss.stop({ graceful: true, timeout: 10_000 });
}
