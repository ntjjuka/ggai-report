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
    case "DATA":
      return `[데이터 ${m.text.length}자]`;
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

/** LLM 전사에 넣는 메시지: 텍스트만. 사진·영상·이모티콘·파일 같은 첨부와 삭제·빈 메시지는 제외한다(통계에는 포함, 숫자 사실로 전달) */
export function buildTranscript(eff: EffectiveMessage[], participants: Map<string, EffectiveParticipant>): TranscriptMessage[] {
  const byId = new Map<string, EffectiveParticipant>();
  for (const p of participants.values()) byId.set(p.id, p);
  return eff.filter((m) => m.kind === "TEXT").map((m) => {
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
      tokens: estimateTokens(`m${m.index} ${m.at.slice(11, 16)} ${name}: ${compactBody(text)}`),
      contextBreakBefore: m.contextBreakBefore,
      ms: m.ms,
    };
  });
}

/** 프롬프트에 넣는 전사 형식 설명 (압축 규칙을 모델에게 알린다) */
export const TRANSCRIPT_FORMAT_NOTE =
  "[전사 형식] `## 날짜 (요일)` 줄 아래에 `mID 시:분 이름: 본문` 한 줄씩. 같은 사람이 2분 안에 연달아 보낸 메시지는 `m200~m203`처럼 묶고 본문은 ` / `로 나눴다. 근거 ID는 묶음 안의 어떤 ID든 쓸 수 있다(첫 ID 권장). `×3`은 같은 내용이 3번 반복됐다는 뜻, `ㅋㅋㅋ`처럼 긴 웃음은 3자로 줄였다. `⏎`는 줄바꿈.";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const MERGE_GAP_MS = 2 * 60_000;
const MERGE_MAX_MSGS = 8;
const MERGE_MAX_CHARS = 320;

/** 본문 압축: 긴 웃음·반복 문장부호·줄바꿈 축약 (통계는 원문으로 계산하므로 렌더에만 적용) */
export function compactBody(text: string): string {
  return text
    .replace(/([ㅋㅎㅠㅜ])\1{2,}/g, "$1$1$1")
    .replace(/([!?~.])\1{2,}/g, "$1$1")
    .replace(/\r?\n+/g, " ⏎ ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 단독 한 줄 렌더 (하이라이트 후보 등 문맥 밖에서 쓰므로 날짜 포함) */
export function renderLine(m: TranscriptMessage): string {
  const prefix = m.contextBreakBefore > 0 ? `[다른 참여자 메시지 ${m.contextBreakBefore}개 생략]\n` : "";
  return `${prefix}${m.id} ${m.at.replace("T", " ").slice(0, 16)} ${m.name}${m.isUploader ? "(나)" : ""}: ${compactBody(m.text)}`;
}

function weekdayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : ` (${WEEKDAYS[d.getUTCDay()]})`;
}

/** 같은 내용 반복(예: [사진] [사진] [사진])을 `[사진] ×3`으로 */
function joinBodies(bodies: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < bodies.length) {
    let j = i + 1;
    while (j < bodies.length && bodies[j] === bodies[i]) j++;
    out.push(j - i >= 2 ? `${bodies[i]} ×${j - i}` : bodies[i]);
    i = j;
  }
  return out.join(" / ");
}

/**
 * 압축 전사: 날짜 헤더 + 짧은 시각 + 같은 사람의 연속 메시지 묶기. 토큰 30~45% 절감 (docs/19).
 * 근거 ID는 전부 보존된다(묶음은 `m200~m203`, 각 ID는 evidence index에 그대로 있음).
 */
export function renderTranscript(messages: TranscriptMessage[], header?: string): string {
  const lines: string[] = [];
  let day = "";
  let i = 0;
  while (i < messages.length) {
    const first = messages[i];
    const date = first.at.slice(0, 10);
    if (date !== day) {
      day = date;
      lines.push(`## ${date}${weekdayOf(date)}`);
    }
    const bodies = [compactBody(first.text)];
    let last = first;
    let j = i + 1;
    let chars = bodies[0].length;
    while (
      j < messages.length &&
      messages[j].pid === first.pid &&
      messages[j].at.slice(0, 10) === date &&
      messages[j].contextBreakBefore === 0 &&
      messages[j].ms - last.ms <= MERGE_GAP_MS &&
      bodies.length < MERGE_MAX_MSGS &&
      chars < MERGE_MAX_CHARS
    ) {
      const b = compactBody(messages[j].text);
      bodies.push(b);
      chars += b.length;
      last = messages[j];
      j++;
    }
    const prefix = first.contextBreakBefore > 0 ? `[다른 참여자 메시지 ${first.contextBreakBefore}개 생략]\n` : "";
    const id = j - i > 1 ? `${first.id}~${last.id}` : first.id;
    lines.push(`${prefix}${id} ${first.at.slice(11, 16)} ${first.name}${first.isUploader ? "(나)" : ""}: ${joinBodies(bodies)}`);
    i = j;
  }
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
