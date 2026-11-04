// 모델 단가 (USD per 1M tokens, 2026-10 기준; 설정으로 덮어쓸 수 있음)
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICE_TABLE: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function priceOf(model: string): ModelPrice {
  return PRICE_TABLE[model] ?? { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceOf(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export function actualCostUsd(model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const p = priceOf(model);
  return (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1_000_000;
}
