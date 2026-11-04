// 2026-11-04 "평가 기준은 지금이다"(docs/14 §12): 대화가 길면 마지막 N개월을 "최근 기준 구간"으로 잡아
// 통계·장부·인용 후보·사건 원문을 그 구간에 더 배정하고, 프롬프트에 "판정은 최근 기준, 과거는 대비·전환점 재료"를 알린다.
import type { Message } from "@/lib/parser/types";
import { formatDuration, monthKey, msToAt, atToMs } from "./time";
import type { StatsFact } from "./facts";
import type { ChatStats } from "./types";

export interface RecentWindow {
  /** 구간 시작(포함) — "YYYY-MM-DDT00:00" 비교용 */
  from: string;
  /** 구간 끝 = 대화 마지막 메시지 시각 */
  to: string;
  months: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 대화 전체 기간이 months × 1.5 보다 길면 마지막 months개월을 "최근 기준 구간"으로 잡는다. 짧은 대화는 전체가 "지금"이므로 null.
 * 기본 6개월: 9개월 미만 대화는 분할하지 않는다.
 */
export function recentWindow(period: { startedAt: string; endedAt: string }, months = 6): RecentWindow | null {
  if (!Number.isFinite(months) || months <= 0) return null;
  const start = atToMs(period.startedAt);
  const end = atToMs(period.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const spanDays = (end - start) / DAY_MS;
  const windowDays = Math.round(months * 30.4);
  if (spanDays < windowDays * 1.5) return null;
  const fromMs = end - windowDays * DAY_MS;
  return { from: `${msToAt(fromMs).slice(0, 10)}T00:00`, to: period.endedAt, months };
}

/** 메시지 시각이 최근 구간 안인가 (구간이 없으면 전부 최근) */
export function isRecent(at: string, window: RecentWindow | null): boolean {
  return !window || at >= window.from;
}

export function recentLabel(window: RecentWindow): string {
  return `최근 ${window.months}개월(${monthKey(window.from)}~${monthKey(window.to)})`;
}

function pct(x: number): number {
  return Math.round(x * 100);
}

function nums(...xs: (number | null | undefined)[]): number[] {
  return xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
}

/**
 * 최근 구간의 통계를 전체와 나란히 문장으로 — "지금"의 숫자. recent는 computeStats(최근 메시지만)의 결과.
 * 종합 프롬프트의 [통계 사실] 뒤에 붙고, 숫자는 allowedNumbers에 자동으로 들어간다.
 */
export function renderRecentFacts(all: ChatStats, recent: ChatStats, window: RecentWindow, messages: Message[]): StatsFact[] {
  const f: StatsFact[] = [];
  const add = (text: string, ...n: (number | null | undefined)[]) => f.push({ text, numbers: nums(...n) });
  const recentCount = messages.filter((m) => m.at >= window.from).length;
  const share = all.total.messages > 0 ? recentCount / all.total.messages : 0;
  const spanMonths = Math.max(1, Math.round(all.period.days / 30.4));
  const earlierMonths = Math.max(1, spanMonths - window.months);
  const earlierPerMonth = Math.round(Math.max(0, all.total.messages - recentCount) / earlierMonths);
  const recentPerMonth = Math.round(recentCount / window.months);
  const trend = recentPerMonth > earlierPerMonth * 1.2 ? "더 바빠졌다" : recentPerMonth < earlierPerMonth * 0.8 ? "식었다" : "비슷하다";
  add(
    `[평가 기준 구간] ${recentLabel(window)}: 메시지 ${recentCount.toLocaleString()}개(전체의 ${pct(share)}%), 월평균 ${recentPerMonth.toLocaleString()}개 — 그 이전 월평균 ${earlierPerMonth.toLocaleString()}개보다 ${trend}. 인물 판정·칭호·예측은 이 구간의 모습을 기준으로 한다.`,
    recentCount,
    pct(share),
    recentPerMonth,
    earlierPerMonth,
  );
  const totalInit = Object.values(recent.sessions.starts).reduce((a, b) => a + b, 0) || 1;
  for (const p of recent.perPerson) {
    const before = all.perPerson.find((q) => q.id === p.id);
    if (p.textMessages === 0 && (before?.textMessages ?? 0) > 0) {
      add(`${p.name}(최근): 텍스트 메시지 0개 — 최근 ${window.months}개월 동안 글을 안 썼다(전체 지분은 ${pct(before?.share ?? 0)}%).`, pct(before?.share ?? 0));
      continue;
    }
    const shareDelta = before ? pct(p.share) - pct(before.share) : 0;
    add(
      `${p.name}(최근): 텍스트 지분 ${pct(p.share)}%${before ? `(전체 ${pct(before.share)}%${shareDelta >= 5 ? ", 최근에 더 떠든다" : shareDelta <= -5 ? ", 최근엔 조용해졌다" : ""})` : ""}, 선톡 ${p.initiations}회(${pct(p.initiations / totalInit)}%), 답장 중앙값 ${p.replyMedianSec === null ? "집계 불가" : formatDuration(p.replyMedianSec)}, 새벽 메시지 ${p.lateNight}개${p.focusWords.length ? `, 최근 집중 단어 ${p.focusWords.map((w) => `${w.word}(${w.count})`).join(" ")}` : ""}.`,
      pct(p.share),
      before ? pct(before.share) : null,
      p.initiations,
      pct(p.initiations / totalInit),
      p.lateNight,
    );
  }
  return f;
}
