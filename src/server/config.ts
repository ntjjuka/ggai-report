import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  APP_CRYPTO_KEY: z.string().min(1), // base64, 32 bytes
  APP_CRYPTO_KEY_ID: z.string().default("k1"),
  PERSONA_NAME: z.string().default("까비서"),
  DEFAULT_TONE: z.enum(["CASUAL", "POLITE"]).default("CASUAL"),
  SCORES_ENABLED: z.string().default("true"),
  LLM_PROVIDER: z.enum(["anthropic", "fake"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_CHUNK_MODEL: z.string().default("claude-sonnet-5-5"),
  /** 전사가 LLM_CHUNK_LARGE_TOKENS를 넘으면 청크 추출에 쓰는 싼 모델 (Haiku 5.5: Sonnet의 1/20 단가) */
  LLM_CHUNK_MODEL_LARGE: z.string().default("claude-haiku-5-5"),
  LLM_CHUNK_LARGE_TOKENS: z.coerce.number().default(1_000_000),
  /** 사고 토큰은 시간·비용 둘 다 먹는다. 종합은 medium이 속도·품질 균형, 청크 추출은 low */
  LLM_SYNTHESIS_EFFORT: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
  LLM_CHUNK_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  /** "synthesis": 종합(Opus) 호출을 fast mode(출력 2.5배 빠름, 단가 2배)로 — 개인용 속도 우선일 때 */
  LLM_FAST_MODE: z.enum(["off", "synthesis"]).default("off"),
  LLM_SYNTHESIS_MODEL: z.string().default("claude-opus-5-5"),
  LLM_FALLBACK_MODEL: z.string().default("claude-opus-4-8"),
  LLM_SINGLE_PASS_MAX_TOKENS: z.coerce.number().default(150_000),
  LLM_CHUNK_MAX_TOKENS: z.coerce.number().default(60_000),
  LLM_MAX_TOTAL_TOKENS: z.coerce.number().default(1_500_000),
  LLM_MAX_COST_USD: z.coerce.number().default(5),
  LLM_CALL_TIMEOUT_MS: z.coerce.number().default(600_000),
  UPLOAD_MAX_BYTES: z.coerce.number().default(50 * 1024 * 1024),
  UPLOAD_MAX_MESSAGES: z.coerce.number().default(300_000),
  UPLOAD_MIN_MESSAGES: z.coerce.number().default(30),
  UPLOAD_MAX_PARTICIPANTS: z.coerce.number().default(60),
  RAW_RETENTION_DAYS: z.coerce.number().default(7),
  STAGE_RESULT_RETENTION_HOURS: z.coerce.number().default(24),
  WORKER_CONCURRENCY: z.coerce.number().default(2),
  WORKER_CHUNK_CONCURRENCY: z.coerce.number().default(8), // 청크 병렬 수. 429가 잦으면 낮춘다
  WORKER_STALE_MINUTES: z.coerce.number().default(3), // 하트비트 30초 주기 → 3분이면 6번 놓친 것. 강제 종료(kill -9) 뒤 복구 지연 상한
  WORKER_MAX_ATTEMPTS: z.coerce.number().default(3),
  WORKER_PIPELINE_TIMEOUT_MINUTES: z.coerce.number().default(25),
  LIMIT_UPLOADS_PER_IP_PER_HOUR: z.coerce.number().default(10),
  LIMIT_REPORTS_PER_OWNER_PER_DAY: z.coerce.number().default(10),
  IP_HASH_SALT: z.string().default("ggai"),
});

export type AppConfig = z.infer<typeof EnvSchema> & { scoresEnabled: boolean; cryptoKey: Buffer };

let cached: AppConfig | null = null;

const KEY_HELP = 'README "로컬 실행" 참고: PowerShell [Convert]::ToBase64String((1..32 | ForEach-Object { [byte](Get-Random -Maximum 256) })) 또는 node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))" 로 만든 값을 .env의 APP_CRYPTO_KEY= 뒤에 붙여넣고, 그 줄에 다른 글자(주석·따옴표)는 두지 않는다';

/**
 * .env 값 정리. Docker Compose는 `KEY=   # 주석`처럼 값이 비어 있으면 주석을 값으로 넘기고,
 * 사용자가 따옴표나 앞뒤 공백을 붙여 넣는 경우도 흔하다 → 다듬은 뒤 비어 있으면 미설정으로 본다.
 */
function sanitizedEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(EnvSchema.shape)) {
    const v = out[k];
    if (typeof v !== "string") continue;
    let t = v.trim();
    if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) t = t.slice(1, -1).trim();
    if (t === "" || t.startsWith("#")) delete out[k];
    else out[k] = t;
  }
  return out;
}

export function getConfig(): AppConfig {
  if (cached) return cached;
  const raw = sanitizedEnv();
  if (!raw.APP_CRYPTO_KEY) throw new Error(`APP_CRYPTO_KEY 가 비어 있습니다. ${KEY_HELP}`);
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`환경 변수 설정 오류: ${missing}`);
  }
  const env = parsed.data;
  const key = Buffer.from(env.APP_CRYPTO_KEY, "base64");
  if (key.length !== 32 || !/^[A-Za-z0-9+/]+=*$/.test(env.APP_CRYPTO_KEY)) {
    throw new Error(`APP_CRYPTO_KEY 는 base64로 인코딩된 32바이트 키여야 합니다 (현재 ${key.length}바이트). ${KEY_HELP}`);
  }
  if (env.LLM_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    // 키가 없으면 SDK가 다른 자격증명(ant auth 프로필)을 시도할 수 있으므로 경고만
    console.warn("[config] ANTHROPIC_API_KEY 가 없습니다. SDK 기본 자격증명 탐색에 의존합니다. 로컬 실행은 LLM_PROVIDER=fake 를 권장합니다.");
  }
  cached = { ...env, scoresEnabled: env.SCORES_ENABLED !== "false", cryptoKey: key };
  return cached;
}

/** 테스트에서 환경을 바꾼 뒤 재로드 */
export function resetConfigForTests(): void {
  cached = null;
}
