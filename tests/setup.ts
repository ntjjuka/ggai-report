import { config } from "dotenv";

// 통합 테스트용 환경. .env.test 가 있으면 우선, 없으면 .env
config({ path: ".env.test" });
config();

process.env.APP_CRYPTO_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.LLM_PROVIDER ??= "fake";
process.env.APP_BASE_URL ??= "http://localhost:3000";
