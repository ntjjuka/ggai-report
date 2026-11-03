// Tier 0 통계 리포트 (docs/15 §B.4): 즉시·무료·LLM 0.
import type { Message } from "@/lib/parser/types";
import { formatDuration } from "@/lib/stats/time";
import type { ChatStats } from "@/lib/stats/types";
import { assignRuleBadges, BADGE_BY_ID, type AwardedBadge } from "./badges";
import { computeAwards, type Tier0Award } from "./awards";
import { HEADLINES, LINES, SIGNATURES, fill, hashSeed, pick, type Line } from "./templates";
import { buildStory, signalInfo, type SignalLevel, type StoryCard } from "./story";

export interface Tier0Report {
  version: 1;
  signal: SignalLevel;
  signalLabel: string;
  signalReasons: string[];
  story: StoryCard[];
  headline: string;
  relationLabel: string;
  lines: Line[];
  badges: (AwardedBadge & { name: string; icon: string })[];
  awards: Tier0Award[];
  signature: string;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export function buildTier0(stats: ChatStats, messages: Message[], seedKey: string): Tier0Report {
  const seed = hashSeed(seedKey);
  const people = stats.perPerson;
  const n = people.length;
  const me = stats.balance ? people.find((p) => p.id === stats.balance!.uploaderId) ?? null : null;
  const other = stats.balance ? people.find((p) => p.id === stats.balance!.otherId) ?? null : null;
  const lines: Line[] = [];
  const pctOf = (x: number) => Math.round(x * 100);

  let headline: string;
  let relationLabel: string;
  if (n === 2 && stats.balance) {
    const b = stats.balance;
    const lean = Math.abs(b.lean);
    const warmthish = people.reduce((a, p) => a + p.laughs + p.emoticons * 2, 0) / Math.max(1, stats.total.textMessages);
    if (lean >= 0.3) {
      headline = pick(HEADLINES.oneWay, seed, 1);
      relationLabel = "한쪽만 달리는 사이";
    } else if (warmthish < 0.3) {
      headline = pick(HEADLINES.cold, seed, 1);
      relationLabel = "미지근한 사이";
    } else {
      headline = pick(HEADLINES.balanced, seed, 1);
      relationLabel = "같은 속도로 걷는 사이";
    }
    const leader = b.lean >= 0 ? me : other;
    const follower = b.lean >= 0 ? other : me;
    const a = pctOf(b.lean >= 0 ? b.initiationRatio : 1 - b.initiationRatio);
    headline = fill(headline, { me: leader?.name, other: follower?.name, n });
    if (Math.abs(b.initiationRatio - 0.5) >= 0.1) {
      lines.push({ topic: "initiation", text: fill(pick(LINES.initiation, seed, 2), { me: leader?.name, a, b: 100 - a }) });
    } else {
      lines.push({ topic: "initiation", text: fill(pick(LINES.initiationBalanced, seed, 2), { a: pctOf(b.initiationRatio), b: 100 - pctOf(b.initiationRatio) }) });
    }
    const ms = pctOf(b.messageRatio);
    lines.push({ topic: "share", text: fill(pick(LINES.share, seed, 3), { a: Math.max(ms, 100 - ms), b: Math.min(ms, 100 - ms) }) });
    if (Math.abs(b.questionRatio - 0.5) >= 0.15) {
      const q = pctOf(b.questionRatio);
      lines.push({ topic: "question", text: fill(LINES.question[0], { a: Math.max(q, 100 - q), b: Math.min(q, 100 - q) }) });
    }
  } else {
    const sorted = [...people].sort((a, b) => b.messages - a.messages);
    const topShare = pctOf((sorted[0]?.messages ?? 0) / Math.max(1, stats.total.messages));
    let acc = 0;
    let active = 0;
    for (const p of sorted) {
      acc += p.messages;
      active += 1;
      if (acc / Math.max(1, stats.total.messages) >= 0.9) break;
    }
    const ghost = stats.funFacts.ghost;
    if (ghost && active <= Math.ceil(n / 2)) {
      headline = pick(HEADLINES.groupGhost, seed, 1);
      relationLabel = "유령 단톡방";
    } else if (stats.period.activeDays / Math.max(1, stats.period.days + 1) >= 0.5) {
      headline = pick(HEADLINES.groupLively, seed, 1);
      relationLabel = "꺼지지 않는 방";
    } else {
      headline = pick(HEADLINES.groupQuiet, seed, 1);
      relationLabel = "공지방이 되어가는 방";
    }
    headline = fill(headline, { n });
    lines.push({ topic: "groupBalance", text: fill(pick(LINES.groupBalance, seed, 2), { topShare, n, active }) });
    if (ghost) lines.push({ topic: "groupGhost", text: fill(pick(LINES.groupGhost, seed, 3), { name: people.find((p) => p.id === ghost.id)?.name, days: ghost.days }) });
  }

  // 공통 라인
  const slow = people.filter((p) => p.replyMedianSec !== null && p.replyCount >= 5).sort((a, b) => (b.replyMedianSec ?? 0) - (a.replyMedianSec ?? 0));
  if (slow.length >= 2 && (slow[0].replyMedianSec ?? 0) >= 3 * (slow[slow.length - 1].replyMedianSec ?? 1) && (slow[0].replyMedianSec ?? 0) >= 600) {
    const fast = slow[slow.length - 1];
    lines.push({ topic: "reply", text: fill(LINES.replyGap[0], { fast: fast.name, fdur: formatDuration(fast.replyMedianSec!), slow: slow[0].name, sdur: formatDuration(slow[0].replyMedianSec!) }) });
  } else if (slow[0] && (slow[0].replyMedianSec ?? 0) >= 3600) {
    lines.push({ topic: "reply", text: fill(pick(LINES.replySlow, seed, 4), { name: slow[0].name, dur: formatDuration(slow[0].replyMedianSec!) }) });
  } else if (slow.length && (slow[slow.length - 1].replyMedianSec ?? Infinity) <= 180) {
    const fast = slow[slow.length - 1];
    lines.push({ topic: "reply", text: fill(pick(LINES.replyFast, seed, 4), { name: fast.name, dur: formatDuration(fast.replyMedianSec!) }) });
  }
  const night = stats.funFacts.nightOwl;
  const totalNight = people.reduce((a, p) => a + p.lateNight, 0);
  if (night && totalNight >= 10) {
    lines.push({ topic: "night", text: fill(pick(LINES.night, seed, 5), { count: totalNight, share: pctOf(night.count / totalNight), name: people.find((p) => p.id === night.id)?.name }) });
  }
  if (stats.funFacts.mostLaughs && stats.funFacts.mostLaughs.perMessage >= 0.5) {
    lines.push({ topic: "laugh", text: fill(pick(LINES.laugh, seed, 6), { name: people.find((p) => p.id === stats.funFacts.mostLaughs!.id)?.name, per: stats.funFacts.mostLaughs.perMessage }) });
  }
  if (stats.funFacts.longestSilence && stats.funFacts.longestSilence.hours >= 48) {
    const ls = stats.funFacts.longestSilence;
    lines.push({ topic: "silence", text: fill(pick(LINES.silence, seed, 7), { dur: formatDuration(ls.hours * 3600), name: people.find((p) => p.id === ls.brokenById)?.name }) });
  }
  if (stats.funFacts.goldenHour) {
    const g = stats.funFacts.goldenHour;
    lines.push({ topic: "golden", text: fill(pick(LINES.golden, seed, 8), { wd: WEEKDAYS[g.weekday], hour: g.hour }) });
  }
  lines.push({
    topic: "volume",
    text: fill(pick(LINES.volume, seed, 9), { total: stats.total.messages.toLocaleString(), days: stats.period.days, perDay: Math.round(stats.total.messages / Math.max(1, stats.period.days)), active: stats.period.activeDays }),
  });

  const badges = assignRuleBadges(stats).map((b) => ({ ...b, name: BADGE_BY_ID[b.badgeId].name, icon: BADGE_BY_ID[b.badgeId].icon }));
  const awards = computeAwards(stats, messages);
  const sig = signalInfo(stats);
  return { version: 1, signal: sig.grade, signalLabel: sig.label, signalReasons: sig.reasons, story: buildStory(stats, messages), headline, relationLabel, lines, badges, awards, signature: pick(SIGNATURES, seed, 11) };
}
