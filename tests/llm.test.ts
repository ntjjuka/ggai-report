import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicLlmClient, extractJsonObject, isGrammarTooLargeError, isNetworkError } from "@/lib/llm";

const Schema = z.object({ headline: z.string(), n: z.number() });

function grammarError() {
  return new Anthropic.BadRequestError(
    400,
    { type: "error", error: { type: "invalid_request_error", message: "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools." } },
    "400 The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.",
    new Headers(),
  );
}

function fakeMessage(text: string, stop = "end_turn") {
  return { id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: stop, stop_sequence: null, content: [{ type: "thinking", thinking: "", signature: "" }, { type: "text", text, citations: null }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}

/** parseImpl = 구조화 출력(format 있음) 호출, createImpl = JSON 모드(format 없음) 호출 — 둘 다 stream().finalMessage() 경로 */
function stubbed(parseImpl: () => Promise<unknown>, createImpl: () => Promise<unknown>) {
  const c = new AnthropicLlmClient({ apiKey: "test-key", sleep: async () => {} });
  const calls = { parse: 0, create: 0, maxTokens: [] as number[], messages: [] as unknown[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = (c as any).client as { messages: { stream: unknown } };
  inner.messages.stream = (params: { max_tokens: number; output_config?: { format?: unknown }; messages: unknown[] }) => {
    calls.maxTokens.push(params.max_tokens);
    calls.messages.push(params.messages);
    const structured = !!params.output_config?.format;
    if (structured) calls.parse += 1;
    else calls.create += 1;
    return { finalMessage: () => (structured ? parseImpl() : createImpl()) };
  };
  return { c, calls };
}

const req = (stage: "CHUNK" | "SYNTHESIS" | "REPAIR") => ({ stage, model: "claude-opus-5-5", system: "sys", user: "user", schema: Schema, maxTokens: 1000, effort: "medium" as const, requestKey: "k" });

describe("anthropic client — JSON mode fallback", () => {
  it("extracts a JSON object from fenced or prefixed text", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('보고서: {"a":{"b":[1,2]}} 끝')).toEqual({ a: { b: [1, 2] } });
    expect(() => extractJsonObject("no json here")).toThrow();
    expect(isGrammarTooLargeError(grammarError())).toBe(true);
    expect(isGrammarTooLargeError(new Error("x"))).toBe(false);
  });

  it("SYNTHESIS uses JSON mode directly and validates with zod", async () => {
    const { c, calls } = stubbed(async () => { throw new Error("parse must not be called"); }, async () => fakeMessage('```json\n{"headline":"둘 중 한 명만 연애 중이다","n":3}\n```'));
    const res = await c.generateJson(req("SYNTHESIS"));
    expect(res.value).toEqual({ headline: "둘 중 한 명만 연애 중이다", n: 3 });
    expect(calls.parse).toBe(0);
    expect(calls.create).toBe(1);
  });

  it("switches a stage to JSON mode after a grammar-too-large 400 and remembers it", async () => {
    const { c, calls } = stubbed(async () => { throw grammarError(); }, async () => fakeMessage('{"headline":"h","n":1}'));
    const first = await c.generateJson(req("CHUNK"));
    expect(first.value).toEqual({ headline: "h", n: 1 });
    expect(calls.parse).toBe(1);
    expect(calls.create).toBe(1);
    await c.generateJson(req("CHUNK"));
    expect(calls.parse).toBe(1); // 두 번째부터는 바로 JSON 모드
    expect(calls.create).toBe(2);
  });

  it("retries once on invalid JSON, then fails with LLM_BAD_OUTPUT", async () => {
    let i = 0;
    const { c } = stubbed(async () => { throw new Error("unused"); }, async () => fakeMessage(i++ === 0 ? "not json" : '{"headline":"h"}'));
    await expect(c.generateJson(req("SYNTHESIS"))).rejects.toMatchObject({ code: "LLM_BAD_OUTPUT" });
    expect(i).toBe(2);
  });

  it("bumps max_tokens once when output is cut off, then fails with LLM_MAX_TOKENS", async () => {
    const { c, calls } = stubbed(async () => { throw new Error("unused"); }, async () => fakeMessage('{"headline":"h"', "max_tokens"));
    await expect(c.generateJson({ ...req("SYNTHESIS"), maxTokens: 64000 })).rejects.toMatchObject({ code: "LLM_MAX_TOKENS" });
    expect(calls.maxTokens).toEqual([64000, 96000]);
  });

  it("fast mode uses the beta stream with speed=fast and falls back to standard on 429", async () => {
    const c = new AnthropicLlmClient({ apiKey: "test-key", sleep: async () => {} });
    const calls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = (c as any).client as { messages: { stream: unknown }; beta: { messages: { stream: unknown } } };
    inner.messages.stream = () => { calls.push("standard"); return { finalMessage: async () => fakeMessage('{"headline":"h","n":1}') }; };
    inner.beta.messages.stream = (params: { speed?: string; betas?: string[] }) => {
      calls.push(`fast:${params.speed}:${(params.betas ?? []).join(",")}`);
      return { finalMessage: async () => { throw new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "fast mode limit" } }, "429 fast mode limit", new Headers()); } };
    };
    const res = await c.generateJson({ ...req("SYNTHESIS"), speed: "fast" });
    expect(res.value).toEqual({ headline: "h", n: 1 });
    expect(calls).toEqual(["fast:fast:fast-mode-2026-02-01", "standard"]);
  });

  it("aborts a stalled stream after the watchdog timeout and retries, then fails as LLM_UNAVAILABLE", async () => {
    const c = new AnthropicLlmClient({ apiKey: "test-key", sleep: async () => {}, timeoutMs: 30, maxAttempts: 2 });
    let aborted = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = (c as any).client as { messages: { stream: unknown } };
    inner.messages.stream = () => {
      let reject: (e: unknown) => void = () => {};
      const p = new Promise<never>((_, rej) => { reject = rej; });
      return { finalMessage: () => p, abort: () => { aborted += 1; reject(new Anthropic.APIUserAbortError({ message: "Request was aborted." })); } };
    };
    await expect(c.generateJson(req("SYNTHESIS"))).rejects.toMatchObject({ code: "LLM_UNAVAILABLE", retryable: true });
    expect(aborted).toBe(2);
  });

  it("other 400s stay LLM_BAD_REQUEST", async () => {
    const { c } = stubbed(async () => { throw new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "model: not found" } }, "400 model: not found", new Headers()); }, async () => fakeMessage("{}"));
    await expect(c.generateJson(req("REPAIR"))).rejects.toMatchObject({ code: "LLM_BAD_REQUEST" });
  });
});

describe("anthropic client — mid-stream network termination", () => {
  it("classifies undici 'terminated' (socket closed while streaming) as a network error", () => {
    const e = new TypeError("terminated");
    (e as { cause?: unknown }).cause = Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" });
    expect(isNetworkError(e)).toBe(true);
    expect(isNetworkError(new Error("fetch failed"))).toBe(true);
    expect(isNetworkError(new Error("응답에 JSON 객체가 없음"))).toBe(false);
    expect(isNetworkError(grammarError())).toBe(false);
  });

  it("retries the same request after the stream is terminated and succeeds on the next attempt", async () => {
    let n = 0;
    const { c, calls } = stubbed(
      async () => { throw new Error("parse must not be called"); },
      async () => {
        n += 1;
        if (n === 1) throw new TypeError("terminated");
        return fakeMessage('{"headline":"h","n":2}');
      },
    );
    const res = await c.generateJson(req("SYNTHESIS"));
    expect(res.value).toEqual({ headline: "h", n: 2 });
    expect(res.attempts).toBe(2);
    expect(calls.create).toBe(2);
  });

  it("gives up as LLM_UNAVAILABLE (retryable) when the stream keeps terminating", async () => {
    const { c, calls } = stubbed(async () => { throw new Error("x"); }, async () => { throw new TypeError("terminated"); });
    await expect(c.generateJson(req("SYNTHESIS"))).rejects.toMatchObject({ code: "LLM_UNAVAILABLE", retryable: true });
    expect(calls.create).toBe(3);
  });
});

describe("anthropic client — split synthesis", () => {
  it("puts the shared context in a cached block ahead of the instructions, and treats SYNTHESIS_* stages as JSON mode", async () => {
    const { c, calls } = stubbed(async () => { throw new Error("parse must not be called"); }, async () => fakeMessage('{"headline":"h","n":1}'));
    const res = await c.generateJson({ ...req("SYNTHESIS"), stage: "SYNTHESIS_PERSONA", user: "[작성 지침] 인물", userCached: "<transcript>…</transcript>" });
    expect(res.value).toEqual({ headline: "h", n: 1 });
    expect(calls.parse).toBe(0);
    const msg = (calls.messages[0] as { content: unknown }[])[0];
    const blocks = msg.content as { type: string; text: string; cache_control?: { type: string } }[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0].text).toBe("<transcript>…</transcript>");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].text.startsWith("[작성 지침] 인물")).toBe(true);
    expect(blocks[1].text).toContain("[출력 형식]");
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it("sends a plain string when there is no cached context", async () => {
    const { c, calls } = stubbed(async () => { throw new Error("x"); }, async () => fakeMessage('{"headline":"h","n":1}'));
    await c.generateJson(req("SYNTHESIS"));
    const msg = (calls.messages[0] as { content: unknown }[])[0];
    expect(typeof msg.content).toBe("string");
  });
});
