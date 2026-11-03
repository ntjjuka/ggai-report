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
const MAX_OUTPUT_TOKENS = 32000;

export class AnthropicLlmClient implements LlmClient {
  readonly provider = "anthropic" as const;
  private readonly client: Anthropic;
  private readonly fallbackModel: string | null;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: AnthropicClientOptions = {}) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: 0, // 재시도는 우리 정책으로만 (이중 재시도 금지)
      timeout: opts.timeoutMs ?? 600_000,
      baseURL: opts.baseUrl,
    });
    this.fallbackModel = opts.fallbackModel ?? null;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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

    while (true) {
      attempts += 1;
      try {
        const res = await this.client.messages.parse({
          model,
          max_tokens: maxTokens,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
          messages: [{ role: "user", content: req.user }],
          output_config: { format: zodOutputFormat(req.schema), effort: req.effort },
        });
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
        if (res.parsed_output === null || res.parsed_output === undefined) {
          if (!badOutputRetried) {
            badOutputRetried = true;
            continue;
          }
          throw new LlmError("LLM_BAD_OUTPUT", "parsed_output null", false);
        }
        return { value: res.parsed_output as T, usage, model: res.model ?? model, latencyMs: Date.now() - started, attempts };
      } catch (e) {
        if (e instanceof LlmError) throw e;
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
