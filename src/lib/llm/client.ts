import type { ZodType } from "zod";

export type Stage = "CHUNK" | "SYNTHESIS" | "REPAIR";
export type Effort = "low" | "medium" | "high" | "xhigh";

export interface StageRequest<T> {
  stage: Stage;
  model: string;
  system: string;
  user: string;
  schema: ZodType<T>;
  maxTokens: number;
  effort: Effort;
  /** 멱등키 (sha256). 호출 로그·체크포인트 키 */
  requestKey: string;
  /** Fake 클라이언트용 힌트 (실제 클라이언트는 무시) */
  hints?: {
    messageIds: string[];
    participantIds: string[];
    speakerOf: Record<string, string>; // messageId → participantId
    uploaderId: string | null;
    numbers: number[];
    scoreKeys: string[];
    priors: Record<string, number | null>;
  };
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface StageResponse<T> {
  value: T;
  usage: Usage;
  model: string;
  latencyMs: number;
  attempts: number;
}

export type LlmErrorCode = "LLM_UNAVAILABLE" | "LLM_BAD_REQUEST" | "LLM_REFUSED" | "LLM_BAD_OUTPUT" | "LLM_MAX_TOKENS";

export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message?: string,
    public readonly retryable = code === "LLM_UNAVAILABLE",
  ) {
    super(message ?? code);
    this.name = "LlmError";
  }
}

export interface LlmClient {
  readonly provider: "anthropic" | "fake";
  generateJson<T>(req: StageRequest<T>): Promise<StageResponse<T>>;
  countTokens(model: string, system: string, user: string): Promise<number>;
}
