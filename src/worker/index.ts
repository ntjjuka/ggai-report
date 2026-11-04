// 워커 프로세스: pg-boss 소비 + 유지보수 스케줄 (stale 복구·원문 만료·체크포인트 정리)
import { writeFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
loadEnv();

import { getConfig } from "@/server/config";
import { closeDb } from "@/server/db";
import { getLlmClient } from "@/server/llm";
import { runMigrations } from "@/server/migrate";
import { REPORT_QUEUE, getBoss, stopBoss, type ReportJobData } from "@/server/queue";
import { expireRawConversations } from "@/server/services/conversations";
import { cleanupStageResults, recoverStaleReports, requeueRunning } from "@/server/services/reports";
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
  try {
    // 직전 프로세스가 남긴 RUNNING/QUEUED 보고서를 즉시 복구 (재시작·배포 뒤 "이미 만들고 있는 보고서" 고착 방지)
    const boot = await recoverStaleReports(new Date(), { bootstrap: true });
    if (boot.requeued || boot.failed) console.info(`[worker] bootstrap recovery: requeued=${boot.requeued} failed=${boot.failed}`);
  } catch (e) {
    console.error("[worker] bootstrap recovery failed:", e instanceof Error ? e.message : String(e));
  }
  // compose healthcheck: 마이그레이션·큐 준비가 끝난 뒤에만 파일을 만든다 → web은 이 뒤에 뜬다 (첫 요청 500 방지)
  if (process.env.WORKER_READY_FILE) {
    try {
      writeFileSync(process.env.WORKER_READY_FILE, new Date().toISOString());
    } catch (e) {
      console.warn(`[worker] ready file write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const active = new Set<string>(); // 이 프로세스가 처리 중인 보고서 (종료 시 즉시 재큐잉)
  for (let i = 0; i < cfg.WORKER_CONCURRENCY; i++) {
    await boss.work<ReportJobData>(REPORT_QUEUE, { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
      for (const job of jobs) {
        const t = Date.now();
        active.add(job.data.reportId);
        try {
          const result = await runReport(job.data.reportId, { llm });
          console.info(`[worker] report ${job.data.reportId} ${result} in ${Math.round((Date.now() - t) / 1000)}s`);
        } finally {
          active.delete(job.data.reportId);
        }
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

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.info(`[worker] ${sig} received, stopping… (처리 중 ${active.size}건은 다시 줄 세움)`);
    try {
      // 처리 중이던 보고서를 먼저 QUEUED로 되돌린다 — 다음 워커가 바로 이어받는다 (docker stop 유예 10초 안에 끝남)
      for (const id of [...active]) {
        try {
          if (await requeueRunning(id)) console.info(`[worker] requeued ${id} on shutdown`);
        } catch (e) {
          console.warn(`[worker] requeue on shutdown failed for ${id}:`, e instanceof Error ? e.message : String(e));
        }
      }
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
