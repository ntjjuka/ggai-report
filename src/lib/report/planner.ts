// docs/08 §5 PLAN: 단일 패스 vs 청크, 월·세션 경계 분할, 샘플링, 비용 추정
import { SESSION_GAP_HOURS } from "@/lib/stats/types";
import { estimateCostUsd } from "@/lib/llm/cost";
import { sampleContextWindows, type TranscriptMessage } from "./transcript";

export interface PlanConfig {
  singlePassMaxTokens: number;
  chunkMaxTokens: number;
  maxTotalTokens: number;
  maxCostUsd: number;
  chunkModel: string;
  synthesisModel: string;
}

export interface Chunk {
  index: number;
  label: string; // "2025-06" 또는 "2025-06 (2/3)"
  messages: TranscriptMessage[];
  tokens: number;
}

export interface Plan {
  mode: "SINGLE" | "CHUNKED";
  chunks: Chunk[]; // SINGLE 이면 1개(전체)
  totalMessages: number;
  includedMessages: number;
  coveragePct: number;
  transcriptTokens: number;
  estimatedCostUsd: number;
}

const GAP_MS = SESSION_GAP_HOURS * 3600_000;
// 출력 토큰 추정에는 사고(thinking) 토큰이 포함된다 (Opus/Sonnet 5.5는 사고를 끌 수 없고 출력 단가로 과금)
const CHUNK_OUT_TOKENS = 6000;
const SYNTH_OUT_TOKENS = 30000;
const SYNTH_FIXED_IN = 6000; // 시스템+통계 사실+지침

export class PlanError extends Error {
  constructor(public readonly code: "COST_LIMIT_EXCEEDED") {
    super(code);
  }
}

function sum(ms: TranscriptMessage[]): number {
  return ms.reduce((a, m) => a + m.tokens, 0);
}

/** 월 버킷 → 초과 월은 세션 경계에서 분할 → 작은 인접 버킷 병합 */
export function chunkByMonth(messages: TranscriptMessage[], chunkMax: number): Chunk[] {
  const months = new Map<string, TranscriptMessage[]>();
  for (const m of messages) {
    const k = m.at.slice(0, 7);
    const arr = months.get(k) ?? [];
    arr.push(m);
    months.set(k, arr);
  }
  const pieces: { label: string; messages: TranscriptMessage[] }[] = [];
  for (const [month, ms] of [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (sum(ms) <= chunkMax) {
      pieces.push({ label: month, messages: ms });
      continue;
    }
    // 세션 경계에서 분할
    const parts: TranscriptMessage[][] = [];
    let cur: TranscriptMessage[] = [];
    let curTokens = 0;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      const sessionStart = i > 0 && m.ms - ms[i - 1].ms >= GAP_MS;
      if (cur.length > 0 && curTokens + m.tokens > chunkMax && (sessionStart || curTokens > chunkMax * 0.9)) {
        parts.push(cur);
        cur = [];
        curTokens = 0;
      }
      cur.push(m);
      curTokens += m.tokens;
    }
    if (cur.length) parts.push(cur);
    parts.forEach((p, i) => pieces.push({ label: `${month} (${i + 1}/${parts.length})`, messages: p }));
  }
  // 작은 인접 조각 병합
  const merged: Chunk[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.tokens + sum(p.messages) <= chunkMax && !last.label.includes("(")) {
      for (const m of p.messages) last.messages.push(m);
      last.tokens += sum(p.messages);
      last.label = `${last.label.split("~")[0]}~${p.label}`;
    } else {
      merged.push({ index: merged.length, label: p.label, messages: [...p.messages], tokens: sum(p.messages) });
    }
  }
  merged.forEach((c, i) => (c.index = i));
  return merged;
}

export function makePlan(messages: TranscriptMessage[], cfg: PlanConfig): Plan {
  const transcriptTokens = sum(messages);
  const totalMessages = messages.length;
  if (transcriptTokens <= cfg.singlePassMaxTokens) {
    const cost = estimateCostUsd(cfg.synthesisModel, transcriptTokens + SYNTH_FIXED_IN, SYNTH_OUT_TOKENS);
    if (cost > cfg.maxCostUsd) throw new PlanError("COST_LIMIT_EXCEEDED");
    return {
      mode: "SINGLE",
      chunks: [{ index: 0, label: "전체", messages, tokens: transcriptTokens }],
      totalMessages,
      includedMessages: totalMessages,
      coveragePct: 100,
      transcriptTokens,
      estimatedCostUsd: round4(cost),
    };
  }
  let chunks = chunkByMonth(messages, cfg.chunkMaxTokens);
  let total = chunks.reduce((a, c) => a + c.tokens, 0);
  const costOf = (cs: Chunk[]) => {
    const t = cs.reduce((a, c) => a + c.tokens, 0);
    const synthIn = SYNTH_FIXED_IN + cs.length * 2500 + cs.length * 25 * 30;
    return estimateCostUsd(cfg.chunkModel, t, cs.length * CHUNK_OUT_TOKENS) + estimateCostUsd(cfg.synthesisModel, synthIn, SYNTH_OUT_TOKENS);
  };
  if (total > cfg.maxTotalTokens) {
    chunks = sampleChunks(chunks, cfg.maxTotalTokens / total, cfg.chunkMaxTokens);
    total = chunks.reduce((a, c) => a + c.tokens, 0);
  }
  let cost = costOf(chunks);
  if (cost > cfg.maxCostUsd) {
    // 한 번 더 축소: 비용 상한에 맞춰 비례 샘플링 (최소 비율 10%)
    const allowedRatio = Math.max(0.1, (cfg.maxCostUsd * 0.8) / cost);
    chunks = sampleChunks(chunks, allowedRatio, cfg.chunkMaxTokens);
    cost = costOf(chunks);
    if (cost > cfg.maxCostUsd) throw new PlanError("COST_LIMIT_EXCEEDED");
  }
  const includedAfter = chunks.reduce((a, c) => a + c.messages.length, 0);
  return {
    mode: "CHUNKED",
    chunks,
    totalMessages,
    includedMessages: includedAfter,
    coveragePct: totalMessages ? Math.round((includedAfter / totalMessages) * 100) : 100,
    transcriptTokens,
    estimatedCostUsd: round4(cost),
  };
}

/** 각 청크 안에서 연속 문맥 창으로 비례 샘플링한 뒤, 작아진 인접 청크를 다시 병합한다. */
function sampleChunks(chunks: Chunk[], ratio: number, chunkMax: number): Chunk[] {
  const sampled = chunks.map((c) => {
    const target = Math.max(1, Math.floor(c.messages.length * ratio));
    const ms = sampleContextWindows(c.messages, target);
    return { ...c, messages: ms, tokens: sum(ms) };
  });
  const merged: Chunk[] = [];
  for (const c of sampled) {
    const last = merged[merged.length - 1];
    if (last && last.tokens + c.tokens <= chunkMax) {
      for (const m of c.messages) last.messages.push(m);
      last.tokens += c.tokens;
      last.label = `${last.label.split("~")[0]}~${c.label}`;
    } else {
      merged.push({ ...c, messages: [...c.messages] });
    }
  }
  merged.forEach((c, i) => (c.index = i));
  return merged;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
