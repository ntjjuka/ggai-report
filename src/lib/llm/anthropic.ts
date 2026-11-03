// Anthropic Java/TS SDK 기반 LLM 클라이언트 (docs/04 §4.3, docs/07 §7)
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LlmError, type LlmClient, type StageRequest, type StageResponse } from "./client";

export interface AnthropicClientOptions {
  apiKey?: string;
  fallbackModel?: string | null;
  maxAttempts?: number; // 429/5xx/네트워크 재시도 상한 (기본 3)
  timeoutMs?: number; // 호출당 (기본 10분)
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [2000, 4000, 8000];
// Opus/Sonnet 5.5는 사고(thinking) 토큰이 max_tokens 안에서 소비된다 → 넉넉히 잡고, 긴 출력은 스트리밍으로 받아 HTTP 타임아웃을 피한다
const MAX_OUTPUT_TOKENS = 120_000;

/**
 * 구조화 출력(output_config.format)은 서버가 JSON Schema를 문법으로 컴파일한다. 종합 초안(ReportDraft)처럼 큰 스키마는
 * 400 "The compiled grammar is too large"로 거부되므로, 그런 단계는 **JSON 모드**로 돌린다: 스키마를 프롬프트에 넣고
 * 응답 텍스트의 JSON을 zod로 검증한다. SYNTHESIS는 처음부터 JSON 모드, 다른 단계는 같은 400을 만나면 전환해 기억한다.
 */
const jsonModeStages = new Set<string>((process.env.LLM_JSON_MODE_STAGES ?? "SYNTHESIS").split(",").map((s) => s.trim()).filter(Boolean));
const GRAMMAR_TOO_LARGE = /compiled grammar is too large|reduce the number of strict tools/i;

export function isGrammarTooLargeError(e: unknown): boolean {
  return e instanceof Anthropic.APIError && e.status === 400 && GRAMMAR_TOO_LARGE.test(e.message);
}

/** 모델 응답 텍스트에서 JSON 객체 하나를 꺼낸다 (코드펜스·서문 허용) */
export function extractJsonObject(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("응답에 JSON 객체가 없음");
  return JSON.parse(t.slice(start, end + 1));
}

function jsonModeSuffix(schemaJson: string, previousFailure: string | null): string {
  return [
    "",
    "[출력 형식] 아래 JSON Schema를 만족하는 JSON 객체 하나만 출력한다. 설명·서문·마크다운 코드펜스 금지. required 키는 전부 채우고, 없는 값은 null 또는 빈 배열로 둔다.",
    schemaJson,
    previousFailure ? `[주의] 직전 출력이 검증에 실패했다: ${previousFailure}. 스키마를 다시 확인해 고친다.` : "",
  ].join("\n");
}

export class AnthropicLlmClient implements LlmClient {
  readonly provider = "anthropic" as const;
  private readonly client: Anthropic;
  private readonly fallbackModel: string | null;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicClientOptions = {}) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: 0, // 재시도는 우리 정책으로만 (이중 재시도 금지)
      timeout: opts.timeoutMs ?? 600_000,
      baseURL: opts.baseUrl,
    });
    this.fallbackModel = opts.fallbackModel ?? null;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 600_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** SDK의 timeout은 응답 헤더까지만 본다. 스트림 본문이 멈추면 보고서가 영원히 RUNNING이 되므로 전체 시간에 워치독을 건다 */
  private async collect<M>(stream: { finalMessage(): Promise<M>; abort(): void }): Promise<M> {
    const timer = setTimeout(() => stream.abort(), this.timeoutMs);
    try {
      return await stream.finalMessage();
    } finally {
      clearTimeout(timer);
    }
  }

  async countTokens(model: string, system: string, user: string): Promise<number> {
    const res = await this.client.messages.countTokens({ model, system, messages: [{ role: "user", content: user }] });
    return res.input_tokens;
  }

  async generateJson<T>(req: StageRequest<T>): Promise<StageResponse<T>> {
    const started = Date.now();
    let attempts = 0;
    let model = req.model;
    let maxTokens = req.maxTokens;
    let usedFallback = false;
    let bumpedTokens = false;
    let badOutputRetried = false;
    let lastFailure: string | null = null;
    let fastDisabled = false;
    const format = zodOutputFormat(req.schema);
    const schemaJson = JSON.stringify(format.schema);
    const system = [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }];

    while (true) {
      attempts += 1;
      const jsonMode = jsonModeStages.has(req.stage);
      const fast = req.speed === "fast" && !fastDisabled && jsonMode && /opus-5|opus-4-8/.test(model);
      try {
        // 항상 스트리밍(finalMessage로 수집): max_tokens가 커도 요청 타임아웃에 걸리지 않는다
        let res: Anthropic.Message & { parsed_output?: unknown };
        if (jsonMode && fast) {
          // Opus fast mode: 출력 2.5배 빠름, 단가 2배. beta 엔드포인트 + beta 플래그 + speed 파라미터 세 가지가 모두 필요
          const beta = await this.collect(
            this.client.beta.messages.stream({
              model,
              max_tokens: maxTokens,
              system,
              messages: [{ role: "user", content: req.user + jsonModeSuffix(schemaJson, lastFailure) }],
              output_config: { effort: req.effort },
              speed: "fast",
              betas: ["fast-mode-2026-02-01"],
            }),
          );
          res = beta as unknown as Anthropic.Message;
        } else if (jsonMode) {
          res = await this.collect(
            this.client.messages.stream({
              model,
              max_tokens: maxTokens,
              system,
              messages: [{ role: "user", content: req.user + jsonModeSuffix(schemaJson, lastFailure) }],
              output_config: { effort: req.effort },
            }),
          );
        } else {
          res = await this.collect(
            this.client.messages.stream({
              model,
              max_tokens: maxTokens,
              system,
              messages: [{ role: "user", content: req.user }],
              output_config: { format, effort: req.effort },
            }),
          );
        }
        const usage = {
          input: res.usage.input_tokens,
          output: res.usage.output_tokens,
          cacheRead: res.usage.cache_read_input_tokens ?? 0,
          cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
        };
        if (res.stop_reason === "refusal") {
          if (this.fallbackModel && !usedFallback && this.fallbackModel !== model) {
            usedFallback = true;
            model = this.fallbackModel;
            continue;
          }
          throw new LlmError("LLM_REFUSED", res.stop_details?.explanation ?? "refused", false);
        }
        if (res.stop_reason === "max_tokens") {
          if (!bumpedTokens && maxTokens < MAX_OUTPUT_TOKENS) {
            bumpedTokens = true;
            maxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.ceil(maxTokens * 1.5));
            continue;
          }
          throw new LlmError("LLM_MAX_TOKENS", "output truncated twice", false);
        }
        let value: T | null = null;
        if (jsonMode) {
          const text = res.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
          try {
            const obj = extractJsonObject(text);
            const checked = req.schema.safeParse(obj);
            if (checked.success) value = checked.data;
            else lastFailure = checked.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
          } catch (e) {
            lastFailure = e instanceof Error ? e.message : String(e);
          }
        } else if (res.parsed_output !== null && res.parsed_output !== undefined) {
          value = res.parsed_output as T;
        } else {
          // 스트림 수집 결과에 parsed_output이 없으면 텍스트를 직접 파싱
          const text = res.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
          try {
            const checked = req.schema.safeParse(extractJsonObject(text));
            if (checked.success) value = checked.data;
            else lastFailure = checked.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
          } catch (e) {
            lastFailure = e instanceof Error ? e.message : String(e);
          }
        }
        if (value === null) {
          if (!badOutputRetried) {
            badOutputRetried = true;
            continue;
          }
          throw new LlmError("LLM_BAD_OUTPUT", jsonMode ? `JSON 검증 실패: ${lastFailure ?? "unknown"}` : "parsed_output null", false);
        }
        return { value, usage, model: res.model ?? model, latencyMs: Date.now() - started, attempts };
      } catch (e) {
        if (e instanceof LlmError) throw e;
        if (fast && (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.BadRequestError)) {
          // fast mode 전용 한도(429)나 미지원(400)이면 표준 속도로 같은 요청을 다시
          console.warn(`[llm] ${req.stage}: fast mode 사용 불가(${describe(e).slice(0, 80)}) → 표준 속도로 전환`);
          fastDisabled = true;
          continue;
        }
        if (!jsonMode && isGrammarTooLargeError(e)) {
          // 스키마 문법이 너무 큼 → 이 단계는 앞으로 JSON 모드. 같은 요청을 즉시 다시 보낸다 (재시도 예산 소모 없음)
          console.warn(`[llm] ${req.stage}: 구조화 출력 문법이 너무 커서 JSON 모드로 전환합니다`);
          jsonModeStages.add(req.stage);
          continue;
        }
        const retryable = isRetryable(e);
        if (retryable && attempts < this.maxAttempts) {
          await this.sleep(RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]);
          continue;
        }
        if (retryable) throw new LlmError("LLM_UNAVAILABLE", describe(e), true);
        if (e instanceof Anthropic.BadRequestError) throw new LlmError("LLM_BAD_REQUEST", describe(e), false);
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
          throw new LlmError("LLM_BAD_REQUEST", describe(e), false);
        }
        throw new LlmError("LLM_UNAVAILABLE", describe(e), true);
      }
    }
  }
}

function isRetryable(e: unknown): boolean {
  if (e instanceof Anthropic.APIUserAbortError) return true; // 워치독 abort(스트림 멈춤) → 재시도
  if (e instanceof Anthropic.RateLimitError) return true;
  if (e instanceof Anthropic.InternalServerError) return true;
  if (e instanceof Anthropic.APIConnectionError) return true; // 타임아웃 포함
  if (e instanceof Anthropic.APIError) return typeof e.status === "number" && (e.status === 429 || e.status >= 500);
  return false;
}

function describe(e: unknown): string {
  if (e instanceof Anthropic.APIError) return `${e.name} ${e.status ?? ""} ${e.message}`.trim();
  return e instanceof Error ? e.message : String(e);
}
