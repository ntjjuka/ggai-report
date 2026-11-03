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

export async function enqueueReportJob(reportId: string, conversationId: string): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(REPORT_QUEUE, { reportId } satisfies ReportJobData, { singletonKey: conversationId });
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

export async function stopBoss(): Promise<void> {
  if (!bossPromise) return;
  const boss = await bossPromise;
  bossPromise = null;
  await boss.stop({ graceful: true, timeout: 10_000 });
}
