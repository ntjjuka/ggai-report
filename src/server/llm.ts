import { AnthropicLlmClient, FakeLlmClient, type FakeScenario, type LlmClient } from "@/lib/llm";
import { getConfig } from "./config";

let client: LlmClient | null = null;

export function getLlmClient(): LlmClient {
  if (client) return client;
  const cfg = getConfig();
  if (cfg.LLM_PROVIDER === "fake") {
    client = new FakeLlmClient((process.env.FAKE_LLM_SCENARIO as FakeScenario | undefined) ?? "ok");
  } else {
    client = new AnthropicLlmClient({ apiKey: cfg.ANTHROPIC_API_KEY, fallbackModel: cfg.LLM_FALLBACK_MODEL, timeoutMs: cfg.LLM_CALL_TIMEOUT_MS });
  }
  return client;
}

export function setLlmClientForTests(c: LlmClient | null): void {
  client = c;
}
