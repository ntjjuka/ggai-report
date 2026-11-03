// Tier 0 통계 스토리 7장 — docs/17 실측 카드 구성 그대로. LLM 없음, 숫자 중심 명사구 라벨.
import type { Message } from "@/lib/parser/types";
import { maskText } from "@/lib/report/transcript";
import type { ChatStats } from "@/lib/stats/types";

export type SignalLevel = "EXCELLENT" | "GOOD" | "FAIR" | "WEAK";
export const SIGNAL_LABEL: Record<SignalLevel, string> = { EXCELLENT: "신호 최상", GOOD: "신호 좋음", FAIR: "신호 보통", WEAK: "신호 약함" };

export function signalLevel(stats: ChatStats): SignalLevel {
  const t = stats.total.textMessages;
  const d = stats.period.activeDays;
  if (t >= 3000 && d >= 30) return "EXCELLENT";
  if (t >= 800 && d >= 10) return "GOOD";
  if (t >= 200) return "FAIR";
  return "WEAK";
}

/** 업로드 응답 최상위 신호 등급 (docs/18 P0-5): 등급 + 사람이 읽는 이유 */
export interface SignalInfo {
  grade: SignalLevel;
  label: string;
  reasons: string[];
}

export function signalInfo(stats: ChatStats): SignalInfo {
  const grade = signalLevel(stats);
  const t = stats.total.textMessages;
  const d = stats.period.activeDays;
  const n = stats.perPerson.length;
  const reasons = [
    `텍스트 메시지 ${t.toLocaleString()}개${t >= 3000 ? " (충분)" : t >= 800 ? " (보통)" : " (적음)"}`,
    `대화한 날 ${d}일${d >= 30 ? " (충분)" : d >= 10 ? " (보통)" : " (적음)"}`,
  ];
  if (n > 2) reasons.push(`참여자 ${n}명`);
  if (grade === "WEAK") reasons.push("보고서는 만들 수 있지만 근거가 얇아 농담보다 숫자가 많을 거예요");
  return { grade, label: SIGNAL_LABEL[grade], reasons };
}

export interface Bubble {
  participantId: string;
  name: string;
  text: string;
  at: string;
}

interface NamedPct {
  id: string;
  name: string;
  pct: number;
}

export type StoryCard =
  | { key: "overview"; title: "한눈에"; messageCount: number; textMessages: number; days: number; activeDays: number; participants: number; from: string; to: string; signal: SignalLevel; signalLabel: string }
  | { key: "who_more_who_first"; title: "누가 더 많이, 누가 먼저"; share: NamedPct[]; restPct: number; initiation: NamedPct[]; vocatives: { id: string; name: string; term: string; count: number }[] }
  | {
      key: "rhythm";
      title: "대화의 리듬";
      fastReply: NamedPct[];
      busiestDay: { date: string; count: number } | null;
      longestStreakDays: number;
      longestSilenceDays: number;
      hourly: number[];
      nightSharePct: number;
      peakHour: number;
    }
  | { key: "longest_messages"; title: "가장 긴 메시지"; items: { id: string; name: string; len: number; date: string; text: string }[] }
  | { key: "first_day"; title: "모든 건 여기서 시작"; date: string; bubbles: Bubble[] }
  | { key: "last_day"; title: "그리고 지금, 여기까지"; date: string; bubbles: Bubble[] }
  | {
      key: "frequent_words";
      title: "자주 쓰는 말";
      laughRanking: { id: string; name: string; count: number }[];
      longestLaughRun: { name: string; len: number } | null;
      verbalTics: { word: string; count: number; ratio: number }[];
      topWords: { word: string; count: number }[];
      topEmojis: { emoji: string; count: number }[];
      emoticonTotal: number;
      emoticonShare: NamedPct[];
    };

const pct = (x: number) => Math.round(x * 100);

export function buildStory(stats: ChatStats, messages: Message[]): StoryCard[] {
  const byIndex = new Map(messages.map((m) => [m.index, m]));
  const name = (id: string) => stats.perPerson.find((p) => p.id === id)?.name ?? id;
  const sortedPeople = [...stats.perPerson].sort((a, b) => b.messages - a.messages);
  const top5 = sortedPeople.slice(0, 5);
  const totalInit = Object.values(stats.sessions.starts).reduce((a, b) => a + b, 0) || 1;
  const bubbles = (indices: number[]): Bubble[] =>
    indices
      .map((i) => byIndex.get(i))
      .filter((m): m is Message => !!m && m.sender !== null)
      .map((m) => {
        const pid = [...stats.perPerson].find((p) => p.name === m.sender)?.id ?? m.sender!;
        return { participantId: pid, name: name(pid) === pid ? m.sender! : name(pid), text: maskText(m.text).slice(0, 200), at: m.at };
      });
  const signal = signalLevel(stats);
  const emoticonTotal = stats.perPerson.reduce((a, p) => a + p.emoticons, 0);
  const ff = stats.funFacts;
  return [
    {
      key: "overview",
      title: "한눈에",
      messageCount: stats.total.messages,
      textMessages: stats.total.textMessages,
      days: stats.period.days,
      activeDays: stats.period.activeDays,
      participants: stats.perPerson.length,
      from: stats.period.startedAt.slice(0, 10),
      to: stats.period.endedAt.slice(0, 10),
      signal,
      signalLabel: SIGNAL_LABEL[signal],
    },
    {
      key: "who_more_who_first",
      title: "누가 더 많이, 누가 먼저",
      share: top5.map((p) => ({ id: p.id, name: p.name, pct: pct(p.share) })),
      restPct: Math.max(0, 100 - top5.reduce((a, p) => a + pct(p.share), 0)),
      initiation: top5.map((p) => ({ id: p.id, name: p.name, pct: pct(p.initiations / totalInit) })),
      vocatives: stats.perPerson
        .filter((p) => p.vocative)
        .sort((a, b) => (b.vocative?.count ?? 0) - (a.vocative?.count ?? 0))
        .slice(0, 3)
        .map((p) => ({ id: p.id, name: p.name, term: p.vocative!.term, count: p.vocative!.count })),
    },
    {
      key: "rhythm",
      title: "대화의 리듬",
      fastReply: stats.perPerson
        .filter((p) => p.fastReplyRate !== null && p.replyCount >= 10)
        .sort((a, b) => (b.fastReplyRate ?? 0) - (a.fastReplyRate ?? 0))
        .slice(0, 3)
        .map((p) => ({ id: p.id, name: p.name, pct: pct(p.fastReplyRate ?? 0) })),
      busiestDay: ff.busiestDay,
      longestStreakDays: ff.longestActiveStreakDays,
      longestSilenceDays: ff.longestSilence ? Math.round(ff.longestSilence.hours / 24) : 0,
      hourly: stats.rhythm.hourly,
      nightSharePct: pct(stats.rhythm.nightShare),
      peakHour: stats.rhythm.peakHour,
    },
    {
      key: "longest_messages",
      title: "가장 긴 메시지",
      items: ff.longestMessages.slice(0, 2).map((lm) => ({ id: lm.id, name: name(lm.id), len: lm.len, date: lm.date, text: maskText(byIndex.get(lm.index)?.text ?? "").slice(0, 400) })),
    },
    { key: "first_day", title: "모든 건 여기서 시작", date: ff.firstDay?.date ?? stats.period.startedAt.slice(0, 10), bubbles: bubbles(ff.firstDay?.indices ?? []).slice(0, 5) },
    { key: "last_day", title: "그리고 지금, 여기까지", date: ff.lastDay?.date ?? stats.period.endedAt.slice(0, 10), bubbles: bubbles(ff.lastDay?.indices ?? []).slice(-5) },
    {
      key: "frequent_words",
      title: "자주 쓰는 말",
      laughRanking: ff.laughRanking.slice(0, 4).map((r) => ({ id: r.id, name: name(r.id), count: r.count })),
      longestLaughRun: ff.longestLaughRun && ff.longestLaughRun.len >= 5 ? { name: name(ff.longestLaughRun.id), len: ff.longestLaughRun.len } : null,
      verbalTics: ff.verbalTics,
      topWords: ff.topWords,
      topEmojis: ff.topEmojis,
      emoticonTotal,
      emoticonShare: top5.map((p) => ({ id: p.id, name: p.name, pct: pct(ff.emoticonShare[p.id] ?? 0) })),
    },
  ];
}
