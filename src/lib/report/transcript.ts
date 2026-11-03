// docs/08 §4 전사 렌더: 메시지 ID 부여, 미디어 축약, PII 마스킹, 토큰 추정
import type { Message } from "@/lib/parser/types";
import type { EffectiveMessage } from "@/lib/stats/computeStats";
import type { EffectiveParticipant } from "@/lib/stats/types";

export interface TranscriptMessage {
  id: string; // m{index}
  index: number;
  at: string;
  pid: string;
  name: string;
  isUploader: boolean;
  kind: Message["kind"];
  text: string; // 마스킹된 본문 (TEXT) 또는 축약 태그
  rawText: string; // 원문(보고서 인용용)
  tokens: number;
  contextBreakBefore: number;
  ms: number;
}

export type EvidenceIndex = Map<string, TranscriptMessage>;

const PHONE_RE = /01[016789]-?\d{3,4}-?\d{4}/g;
const RRN_RE = /\d{6}-?[1-4]\d{6}/g;
const ACCOUNT_RE = /\b\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,6})?\b/g;
const URL_RE = /https?:\/\/([^\s/]+)[^\s]*/g;

export function maskText(text: string): string {
  return text
    .replace(URL_RE, (_, host: string) => `[링크: ${host.replace(/^www\./, "")}]`)
    .replace(RRN_RE, "[주민번호]")
    .replace(PHONE_RE, "[전화번호]")
    .replace(ACCOUNT_RE, "[계좌]");
}

/** 한국어 혼합 텍스트 보수적 추정: 1.6자 ≈ 1토큰 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.6) + 1;
}

function mediaTag(m: EffectiveMessage): string {
  switch (m.kind) {
    case "PHOTO":
      return m.text.startsWith("사진 ") ? `[${m.text}]` : "[사진]";
    case "VIDEO":
      return "[동영상]";
    case "EMOTICON":
      return "[이모티콘]";
    case "VOICE":
      return "[음성]";
    case "FILE":
      return `[파일: ${m.text.replace(/^(파일|File):\s*/, "").slice(0, 40)}]`;
    case "MAP":
      return "[지도]";
    case "CONTACT":
      return "[연락처]";
    case "DELETED":
      return "[삭제됨]";
    case "EMPTY":
      return "";
    default:
      return maskText(m.text);
  }
}

export function buildTranscript(eff: EffectiveMessage[], participants: Map<string, EffectiveParticipant>): TranscriptMessage[] {
  const byId = new Map<string, EffectiveParticipant>();
  for (const p of participants.values()) byId.set(p.id, p);
  return eff.map((m) => {
    const p = byId.get(m.pid);
    const text = mediaTag(m);
    const name = p?.name ?? m.pid;
    return {
      id: `m${m.index}`,
      index: m.index,
      at: m.at,
      pid: m.pid,
      name,
      isUploader: p?.isUploader ?? false,
      kind: m.kind,
      text,
      rawText: m.text,
      tokens: estimateTokens(`m${m.index} [${m.at}] ${name}: ${text}`),
      contextBreakBefore: m.contextBreakBefore,
      ms: m.ms,
    };
  });
}

export function renderLine(m: TranscriptMessage): string {
  const body = m.text.includes("\n") ? m.text.split("\n").join("\n     ") : m.text;
  const prefix = m.contextBreakBefore > 0 ? `[다른 참여자 메시지 ${m.contextBreakBefore}개 생략]\n` : "";
  return `${prefix}${m.id} [${m.at.replace("T", " ")}] ${m.name}${m.isUploader ? "(나)" : ""}: ${body}`;
}

export function renderTranscript(messages: TranscriptMessage[], header?: string): string {
  const lines = messages.map(renderLine);
  return header ? `${header}\n${lines.join("\n")}` : lines.join("\n");
}

/** 연속 문맥 창 샘플링 (toksai renderBucketText 방식): 균등 배치된 창 2~8개 */
export function sampleContextWindows<T>(items: T[], target: number): T[] {
  if (target >= items.length) return items;
  const total = items.length;
  const windowCount = Math.min(8, Math.max(2, Math.floor(Math.sqrt(target))));
  const windowSize = Math.max(1, Math.floor(target / windowCount));
  const picked = new Set<number>();
  for (let i = 0; i < windowCount; i++) {
    const start = windowCount === 1 ? 0 : Math.round((i * (total - windowSize)) / (windowCount - 1));
    for (let j = start; j < Math.min(total, start + windowSize); j++) picked.add(j);
  }
  return [...picked].sort((a, b) => a - b).map((i) => items[i]);
}

export function buildEvidenceIndex(messages: TranscriptMessage[]): EvidenceIndex {
  return new Map(messages.map((m) => [m.id, m]));
}
