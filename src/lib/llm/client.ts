import type { ZodType } from "zod";

/**
 * 종합 갈래 단계명 (DB stage 컬럼 20자 이내): SYNTHESIS_SCENES(장·章만) → SYNTHESIS_PERSONA(인물 2~3명 묶음, 병렬) ∥ SYNTHESIS_VERDICT(판정·나머지).
 * SYNTHESIS는 한 호출 종합(LLM_SYNTH_SPLIT=off)
 */
export type Stage = "CHUNK" | "SYNTHESIS" | "SYNTHESIS_SCENES" | "SYNTHESIS_PERSONA" | "SYNTHESIS_VERDICT" | "REPAIR";
export type Effort = "low" | "medium" | "high" | "xhigh";

export interface StageRequest<T> {
  stage: Stage;
  model: string;
  system: string;
  user: string;
  /** 사용자 메시지 앞에 붙는 공유 문맥(전사·청크 JSON 등). 프롬프트 캐시 경계를 걸어 두 갈래 종합 호출이 입력을 한 번만 산다 */
  userCached?: string;
  schema: ZodType<T>;
  maxTokens: number;
  effort: Effort;
  /** 멱등키 (sha256). 호출 로그·체크포인트 키 */
  requestKey: string;
  /** "fast": Opus fast mode(beta). 지원 모델이 아니거나 429면 표준 속도로 자동 복귀 */
  speed?: "fast";
  /** Fake 클라이언트용 힌트 (실제 클라이언트는 무시) */
  hints?: {
    messageIds: string[];
    participantIds: string[];
    speakerOf: Record<string, string>; // messageId → participantId
    uploaderId: string | null;
    numbers: number[];
    scoreKeys: string[];
    priors: Record<string, number | null>;
    /** SYNTHESIS_PERSONA 묶음 호출: 이 호출이 써야 하는 참여자 ID (없으면 전원) */
    batchIds?: string[];
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
