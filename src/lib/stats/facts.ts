// docs/08 §7.1 "숫자 로스트 재료": 서버가 계산한 사실을 문장으로. LLM은 이 숫자만 쓴다.
import type { Message } from "@/lib/parser/types";
import { formatDuration } from "./time";
import type { ChatStats } from "./types";
import type { ScorePrior } from "./priors";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export interface StatsFact {
  text: string;
  /** 문장에 등장한 숫자(검증기용) */
  numbers: number[];
}

function nums(...xs: (number | null | undefined)[]): number[] {
  return xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
}

function pct(x: number): number {
  return Math.round(x * 100);
}

export function renderStatsFacts(stats: ChatStats, messages: Message[], priors: ScorePrior[]): StatsFact[] {
  const name = (id: string) => stats.perPerson.find((p) => p.id === id)?.name ?? id;
  const byIndex = new Map(messages.map((m) => [m.index, m]));
  const f: StatsFact[] = [];
  const add = (text: string, ...n: (number | null | undefined)[]) => f.push({ text, numbers: nums(...n) });

  add(
    `전체: 메시지 ${stats.total.messages.toLocaleString()}개(텍스트 ${stats.total.textMessages.toLocaleString()}개), 기간 ${stats.period.days}일, 대화한 날 ${stats.period.activeDays}일, 세션 ${stats.sessions.count}개(평균 ${stats.sessions.avgLenMsgs}개 메시지).`,
    stats.total.messages,
    stats.total.textMessages,
    stats.period.days,
    stats.period.activeDays,
    stats.sessions.count,
    stats.sessions.avgLenMsgs,
  );
  const totalInit = Object.values(stats.sessions.starts).reduce((a, b) => a + b, 0) || 1;
  for (const p of stats.perPerson) {
    add(
      `${p.name}: 메시지 ${p.messages.toLocaleString()}개(${pct(p.share)}%), 선톡 ${p.initiations}회(${pct(p.initiations / totalInit)}%), 답장 중앙값 ${p.replyMedianSec === null ? "집계 불가" : formatDuration(p.replyMedianSec)}${p.replyP90Sec === null ? "" : `(상위 10%는 ${formatDuration(p.replyP90Sec)} 이상)`}, 평균 ${p.avgLen}자, 질문 ${p.questions}개, ㅋ/ㅎ ${p.laughs}개, 이모티콘 ${p.emoticons}개, 사진 ${p.photos}장, 새벽(0~5시) 메시지 ${p.lateNight}개, 링크 ${p.links}개, 대화 마무리 ${p.sessionEnds}회.`,
      p.messages,
      pct(p.share),
      p.initiations,
      pct(p.initiations / totalInit),
      p.avgLen,
      p.questions,
      p.laughs,
      p.emoticons,
      p.photos,
      p.lateNight,
      p.links,
      p.sessionEnds,
    );
  }
  if (stats.balance) {
    const b = stats.balance;
    add(
      `균형(2인): ${name(b.uploaderId)} 선톡 ${pct(b.initiationRatio)}% / ${name(b.otherId)} ${100 - pct(b.initiationRatio)}%. 질문 비율 ${pct(b.questionRatio)}:${100 - pct(b.questionRatio)}. 기울기 지수 ${b.lean}(양수면 ${name(b.uploaderId)}가 더 달림).`,
      pct(b.initiationRatio),
      100 - pct(b.initiationRatio),
      pct(b.questionRatio),
      100 - pct(b.questionRatio),
      b.lean,
    );
  }
  const ff = stats.funFacts;
  if (ff.goldenHour) add(`가장 많이 떠든 시간대: ${WEEKDAYS[ff.goldenHour.weekday]}요일 ${ff.goldenHour.hour}시(${ff.goldenHour.count}개).`, ff.goldenHour.hour, ff.goldenHour.count);
  if (ff.busiestDay) add(`가장 바빴던 날: ${ff.busiestDay.date} (${ff.busiestDay.count}개).`, ff.busiestDay.count);
  if (ff.longestSilence) {
    const m = byIndex.get(ff.longestSilence.messageIndex);
    add(
      `최장 침묵 ${formatDuration(ff.longestSilence.hours * 3600)}(${ff.longestSilence.hours}시간), 깬 사람 ${name(ff.longestSilence.brokenById)} (m${ff.longestSilence.messageIndex}${m && m.kind === "TEXT" ? ` "${m.text.slice(0, 40)}"` : ""}).`,
      ff.longestSilence.hours,
    );
  }
  if (ff.nightOwl && ff.nightOwl.count > 0) add(`새벽 감성 1위: ${name(ff.nightOwl.id)} (0~5시 ${ff.nightOwl.count}개).`, ff.nightOwl.count);
  if (ff.mostLaughs) add(`ㅋ 밀도 1위: ${name(ff.mostLaughs.id)} (메시지당 ${ff.mostLaughs.perMessage}개).`, ff.mostLaughs.perMessage);
  if (ff.ghost) add(`최장 잠수: ${name(ff.ghost.id)} ${ff.ghost.days}일 무발화.`, ff.ghost.days);
  if (ff.mostPhotos && ff.mostPhotos.count > 0) add(`사진 셔틀: ${name(ff.mostPhotos.id)} ${ff.mostPhotos.count}장.`, ff.mostPhotos.count);
  if (ff.linkCurator && ff.linkCurator.count > 0) add(`링크 수집가: ${name(ff.linkCurator.id)} ${ff.linkCurator.count}개.`, ff.linkCurator.count);
  for (const [pid, emoji] of Object.entries(ff.topEmoji)) if (emoji) add(`${name(pid)} 최애 이모지: ${emoji}.`);
  const months = stats.rhythm.monthly;
  if (months.length >= 2) {
    const peak = [...months].sort((a, b) => b.total - a.total)[0];
    const low = [...months].sort((a, b) => a.total - b.total)[0];
    add(`월별 최다 ${peak.month}(${peak.total}개), 최저 ${low.month}(${low.total}개). 최근 달 ${months[months.length - 1].month} ${months[months.length - 1].total}개.`, peak.total, low.total, months[months.length - 1].total);
  }
  for (const pr of priors) if (pr.prior !== null) add(`점수 prior ${pr.key}(${pr.label}) = ${pr.prior} (${pr.basis}).`, pr.prior);
  return f;
}

export function factsToText(facts: StatsFact[]): string {
  return facts.map((x) => `- ${x.text}`).join("\n");
}

export function allowedNumbers(facts: StatsFact[]): Set<number> {
  const s = new Set<number>();
  for (const x of facts) for (const n of x.numbers) s.add(n);
  return s;
}
