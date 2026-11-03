// docs/07 §1 뱃지 카탈로그 + Tier 0 규칙 평가 (LLM 없이 통계만으로 부여)
import type { ChatStats, PersonStat } from "@/lib/stats/types";

export interface Badge {
  id: string;
  name: string;
  icon: string;
  description: string;
}

export const BADGES: Badge[] = [
  { id: "first_texter", name: "선톡왕", icon: "📣", description: "먼저 말 거는 걸 두려워하지 않는 사람" },
  { id: "reply_fairy", name: "답장요정", icon: "⚡", description: "답장이 빛의 속도인 사람" },
  { id: "slow_burner", name: "느림의미학", icon: "🐢", description: "답장은 느려도 오긴 오는 사람" },
  { id: "night_owl", name: "새벽감성", icon: "🌙", description: "늦은 밤 대화가 유독 많은 사람" },
  { id: "essay_writer", name: "장문파", icon: "📜", description: "한 번 보내면 소설을 쓰는 사람" },
  { id: "laugh_machine", name: "ㅋㅋ제조기", icon: "😆", description: "ㅋ과 ㅎ이 끊이지 않는 사람" },
  { id: "emoji_bomber", name: "이모지폭격기", icon: "💥", description: "이모티콘으로 감정을 표현하는 사람" },
  { id: "question_master", name: "궁금이", icon: "❓", description: "질문으로 대화를 이어가는 사람" },
  { id: "photo_shuttle", name: "사진셔틀", icon: "📷", description: "사진으로 말하는 사람" },
  { id: "link_curator", name: "링크수집가", icon: "🔗", description: "링크로 대화를 여는 사람" },
  { id: "ghost", name: "유령회원", icon: "👻", description: "오래 사라졌다 돌아오는 사람" },
  { id: "mood_maker", name: "분위기메이커", icon: "🎉", description: "웃음과 이모티콘으로 판을 띄우는 사람" },
  { id: "decider", name: "결정권자", icon: "⚖️", description: "결정을 내리는 사람" },
  { id: "planner", name: "총무", icon: "📋", description: "계획과 실행을 챙기는 사람" },
  { id: "meme_dealer", name: "밈공급자", icon: "🃏", description: "밈과 유행어를 공급하는 사람" },
  { id: "peacemaker", name: "중재자", icon: "🕊️", description: "싸움을 끝내는 사람" },
  { id: "topic_hopper", name: "주제점프", icon: "🦘", description: "화제를 자주 바꾸는 사람" },
  { id: "closer", name: "마무리담당", icon: "🔚", description: "대화의 마지막 말을 하는 사람" },
  { id: "seen_zone_master", name: "읽씹장인", icon: "👀", description: "읽고 답을 미루는 사람" },
  { id: "promise_breaker", name: "약속파기자", icon: "🗓️", description: "'보자'는 많고 만남은 적은 사람" },
];

export const BADGE_BY_ID: Record<string, Badge> = Object.fromEntries(BADGES.map((b) => [b.id, b]));
export const BADGE_IDS = BADGES.map((b) => b.id);

export interface AwardedBadge {
  participantId: string;
  badgeId: string;
  reason: string;
}

/** 통계 규칙만으로 부여 가능한 뱃지(사람당 최대 2개). 내용 이해가 필요한 뱃지(결정권자·중재자 등)는 LLM 단계에서만. */
export function assignRuleBadges(stats: ChatStats): AwardedBadge[] {
  const people = stats.perPerson;
  if (people.length === 0) return [];
  const totalInit = Object.values(stats.sessions.starts).reduce((a, b) => a + b, 0) || 1;
  const totalPhotos = people.reduce((a, p) => a + p.photos, 0);
  const totalEnds = people.reduce((a, p) => a + p.sessionEnds, 0) || 1;
  const candidates: (AwardedBadge & { priority: number })[] = [];
  const top = (score: (p: PersonStat) => number) => {
    let best: PersonStat | null = null;
    let bestScore = -Infinity;
    for (const p of people) {
      const s = score(p);
      if (s > bestScore) [best, bestScore] = [p, s];
    }
    return { best, bestScore };
  };
  const fmtMin = (sec: number) => (sec < 3600 ? `${Math.max(1, Math.round(sec / 60))}분` : `${Math.round((sec / 3600) * 10) / 10}시간`);

  // 선톡왕: 선톡 비율 top & ≥ 1.4배 평균
  {
    const { best } = top((p) => p.initiations);
    if (best && best.initiations >= 3 && best.initiations / totalInit >= Math.min(0.6, 1.4 / people.length)) {
      candidates.push({ participantId: best.id, badgeId: "first_texter", reason: `선톡 ${best.initiations}회 (${Math.round((best.initiations / totalInit) * 100)}%)`, priority: 9 });
    }
  }
  for (const p of people) {
    if (p.replyMedianSec !== null && p.replyCount >= 10) {
      if (p.replyMedianSec <= 180) candidates.push({ participantId: p.id, badgeId: "reply_fairy", reason: `답장 중앙값 ${fmtMin(p.replyMedianSec)}`, priority: 8 });
      else if (p.replyMedianSec >= 6 * 3600) candidates.push({ participantId: p.id, badgeId: "seen_zone_master", reason: `답장 중앙값 ${fmtMin(p.replyMedianSec)}`, priority: 10 });
      else if (p.replyMedianSec >= 2 * 3600) candidates.push({ participantId: p.id, badgeId: "slow_burner", reason: `답장 중앙값 ${fmtMin(p.replyMedianSec)}`, priority: 7 });
    }
    if (p.messages >= 20 && p.lateNight / p.messages >= 0.15) candidates.push({ participantId: p.id, badgeId: "night_owl", reason: `새벽 메시지 ${p.lateNight}개 (${Math.round((p.lateNight / p.messages) * 100)}%)`, priority: 6 });
    if (p.textMessages >= 20 && p.avgLen >= 40) candidates.push({ participantId: p.id, badgeId: "essay_writer", reason: `평균 ${p.avgLen}자`, priority: 5 });
    if (p.textMessages >= 20 && p.laughs / p.textMessages >= 2) candidates.push({ participantId: p.id, badgeId: "laugh_machine", reason: `메시지당 ㅋ ${Math.round((p.laughs / p.textMessages) * 10) / 10}개`, priority: 6 });
    if (p.messages >= 20 && p.emoticons / p.messages >= 0.2) candidates.push({ participantId: p.id, badgeId: "emoji_bomber", reason: `메시지의 ${Math.round((p.emoticons / p.messages) * 100)}%가 이모티콘`, priority: 5 });
    if (p.textMessages >= 20 && p.questions / p.textMessages >= 0.3) candidates.push({ participantId: p.id, badgeId: "question_master", reason: `질문 ${p.questions}개`, priority: 5 });
    if (p.photos >= 10 && p.photos / Math.max(1, totalPhotos) >= 0.3) candidates.push({ participantId: p.id, badgeId: "photo_shuttle", reason: `사진 ${p.photos}장`, priority: 4 });
    if (p.links >= 5) candidates.push({ participantId: p.id, badgeId: "link_curator", reason: `링크 ${p.links}개`, priority: 4 });
    if (people.length >= 3 && p.longestSilentDays >= 14) candidates.push({ participantId: p.id, badgeId: "ghost", reason: `${p.longestSilentDays}일 잠수`, priority: 7 });
    if (people.length === 2 && totalEnds >= 10 && p.sessionEnds / totalEnds >= 0.65) candidates.push({ participantId: p.id, badgeId: "closer", reason: `대화 마무리 ${p.sessionEnds}회 (${Math.round((p.sessionEnds / totalEnds) * 100)}%)`, priority: 4 });
  }
  if (people.length >= 3) {
    const { best } = top((p) => p.laughs + p.emoticons * 3);
    if (best && best.laughs + best.emoticons * 3 >= 30) candidates.push({ participantId: best.id, badgeId: "mood_maker", reason: `ㅋ ${best.laughs}개 + 이모티콘 ${best.emoticons}개`, priority: 6 });
  }
  // 사람당 2개, 우선순위 순
  const byPerson = new Map<string, (AwardedBadge & { priority: number })[]>();
  for (const c of candidates.sort((a, b) => b.priority - a.priority)) {
    const arr = byPerson.get(c.participantId) ?? [];
    if (arr.length < 2 && !arr.some((x) => x.badgeId === c.badgeId)) arr.push(c);
    byPerson.set(c.participantId, arr);
  }
  return [...byPerson.values()].flat().map(({ participantId, badgeId, reason }) => ({ participantId, badgeId, reason }));
}
