// 워커 프로세스: pg-boss 소비 + 유지보수 스케줄 (stale 복구·원문 만료·체크포인트 정리)
import { config as loadEnv } from "dotenv";
loadEnv();

import { getConfig } from "@/server/config";
import { closeDb } from "@/server/db";
import { getLlmClient } from "@/server/llm";
import { runMigrations } from "@/server/migrate";
import { REPORT_QUEUE, getBoss, stopBoss, type ReportJobData } from "@/server/queue";
import { expireRawConversations } from "@/server/services/conversations";
import { cleanupStageResults, recoverStaleReports } from "@/server/services/reports";
import { runReport } from "./pipeline";

async function main(): Promise<void> {
  const cfg = getConfig();
  if (process.env.MIGRATE_ON_START !== "false") {
    const applied = await runMigrations(cfg.DATABASE_URL);
    if (applied.length) console.info(`[worker] migrations applied: ${applied.join(", ")}`);
  }
  const boss = await getBoss("worker");
  const llm = getLlmClient();
  console.info(`[worker] started · provider=${llm.provider} · concurrency=${cfg.WORKER_CONCURRENCY}`);

  for (let i = 0; i < cfg.WORKER_CONCURRENCY; i++) {
    await boss.work<ReportJobData>(REPORT_QUEUE, { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
      for (const job of jobs) {
        const t = Date.now();
        const result = await runReport(job.data.reportId, { llm });
        console.info(`[worker] report ${job.data.reportId} ${result} in ${Math.round((Date.now() - t) / 1000)}s`);
      }
    });
  }

  const every = (ms: number, fn: () => Promise<unknown>, label: string) => {
    const timer = setInterval(() => {
      fn().catch((e) => console.error(`[worker] ${label} failed:`, e instanceof Error ? e.message : String(e)));
    }, ms);
    timer.unref();
    return timer;
  };
  every(60_000, async () => {
    const r = await recoverStaleReports();
    if (r.requeued || r.failed) console.info(`[worker] stale recovery: requeued=${r.requeued} failed=${r.failed}`);
  }, "stale-recovery");
  every(10 * 60_000, async () => {
    const n = await expireRawConversations();
    if (n) console.info(`[worker] raw expired: ${n}`);
  }, "raw-expire");
  every(60 * 60_000, async () => {
    const n = await cleanupStageResults();
    if (n) console.info(`[worker] stage results cleaned: ${n}`);
  }, "stage-cleanup");

  const shutdown = async (sig: string) => {
    console.info(`[worker] ${sig} received, stopping…`);
    try {
      await stopBoss();
      await closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
