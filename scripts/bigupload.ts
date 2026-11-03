// 대용량 내보내기 파일을 업로드 서비스 경로로 직접 태워 보는 점검 도구 (DB 필요, 워커 불필요)
// 사용: pnpm tsx scripts/bigupload.ts <파일.txt|.zip>   → 파싱·통계·Tier 0·암호화·DB 저장까지의 시간과 결과
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv();
import { closeDb } from "@/server/db";
import { uploadConversation } from "@/server/services/conversations";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("사용: pnpm tsx scripts/bigupload.ts <파일>");
  const bytes = new Uint8Array(readFileSync(file));
  const t = Date.now();
  const r = await uploadConversation({ files: [{ name: basename(file), bytes }], ownerHash: "d".repeat(64), ipHash: "e".repeat(64), title: null, focus: "AUTO" });
  console.log(`OK ${r.detail.messageCount.toLocaleString()} msgs · ${r.detail.participantCount} ppl · ${Date.now() - t} ms · signal ${r.detail.signal?.grade} · ${(bytes.length / 1024 / 1024).toFixed(1)} MB · reused=${r.reused}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.stack : String(e));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
