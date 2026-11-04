// Tier 0 어워드: 통계 순위만으로 수상자를 정한다. 이름은 행동 기반(14 §4-8).
import type { Message } from "@/lib/parser/types";
import type { ChatStats } from "@/lib/stats/types";
import { formatDuration } from "@/lib/stats/time";

export interface Tier0Award {
  name: string;
  participantId: string | null;
  reason: string;
  messageIndex: number | null;
}

export function computeAwards(stats: ChatStats, messages: Message[]): Tier0Award[] {
  const people = stats.perPerson;
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  const out: Tier0Award[] = [];
  const byIndex = new Map(messages.map((m) => [m.index, m]));

  const slow = people.filter((p) => p.replyMedianSec !== null && p.replyCount >= 5).sort((a, b) => (b.replyMedianSec ?? 0) - (a.replyMedianSec ?? 0))[0];
  if (slow && (slow.replyMedianSec ?? 0) >= 1800) {
    out.push({ name: "읽씹 장인상", participantId: slow.id, reason: `답장 중앙값 ${formatDuration(slow.replyMedianSec!)}`, messageIndex: null });
  }
  const totalInit = Object.values(stats.sessions.starts).reduce((a, b) => a + b, 0) || 1;
  const initiator = [...people].sort((a, b) => b.initiations - a.initiations)[0];
  if (initiator && initiator.initiations >= 3) {
    out.push({ name: people.length === 2 ? "편집장상" : "방송국상", participantId: initiator.id, reason: `대화 시작 ${initiator.initiations}회 (${Math.round((initiator.initiations / totalInit) * 100)}%)`, messageIndex: null });
  }
  if (stats.funFacts.nightOwl && stats.funFacts.nightOwl.count >= 10) {
    out.push({ name: "새벽 감성상", participantId: stats.funFacts.nightOwl.id, reason: `0~5시 메시지 ${stats.funFacts.nightOwl.count}개`, messageIndex: null });
  }
  if (stats.funFacts.mostPhotos && stats.funFacts.mostPhotos.count >= 10) {
    out.push({ name: "사진 셔틀상", participantId: stats.funFacts.mostPhotos.id, reason: `사진 ${stats.funFacts.mostPhotos.count}장`, messageIndex: null });
  }
  if (stats.funFacts.linkCurator && stats.funFacts.linkCurator.count >= 5) {
    out.push({ name: "링크 한 방상", participantId: stats.funFacts.linkCurator.id, reason: `링크 ${stats.funFacts.linkCurator.count}개`, messageIndex: null });
  }
  if (stats.funFacts.ghost) {
    out.push({ name: "유령 회원상", participantId: stats.funFacts.ghost.id, reason: `${stats.funFacts.ghost.days}일 잠수 후 귀환`, messageIndex: null });
  }
  if (stats.funFacts.mostLaughs && stats.funFacts.mostLaughs.perMessage >= 1) {
    out.push({ name: "ㅋㅋ 제조기상", participantId: stats.funFacts.mostLaughs.id, reason: `메시지당 ㅋ ${stats.funFacts.mostLaughs.perMessage}개`, messageIndex: null });
  }
  const ls = stats.funFacts.longestSilence;
  if (ls) {
    const m = byIndex.get(ls.messageIndex);
    if (m && m.kind === "TEXT") {
      out.push({ name: "침묵을 깬 한 줄상", participantId: ls.brokenById, reason: `${formatDuration(ls.hours * 3600)} 만에 ${name(ls.brokenById)}가 보낸 "${m.text.slice(0, 30)}"`, messageIndex: ls.messageIndex });
    }
  }
  return out.slice(0, 6);
}
