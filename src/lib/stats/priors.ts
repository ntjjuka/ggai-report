// docs/07 §3.1 점수 prior (0~100). LLM이 참고하고 검증기가 ±40 클램프에 쓴다.
import type { ChatStats } from "./types";

export type ScoreKey =
  | "reply_radar"
  | "initiative_balance"
  | "warmth"
  | "repair_reflex"
  | "follow_through"
  | "participation_balance"
  | "energy"
  | "humor_density"
  | "plan_execution"
  | "cohesion"
  | "responsiveness"
  | "clarity"
  | "decision_speed"
  | "load_balance"
  | "tone_safety";

export interface ScorePrior {
  key: ScoreKey;
  label: string;
  prior: number | null; // null = LLM 전적 판단
  basis: string;
}

export type ScoreSet = "PAIR" | "GROUP" | "WORK";

export const SCORE_SETS: Record<ScoreSet, ScoreKey[]> = {
  PAIR: ["reply_radar", "initiative_balance", "warmth", "repair_reflex", "follow_through"],
  GROUP: ["participation_balance", "energy", "humor_density", "plan_execution", "cohesion"],
  WORK: ["responsiveness", "clarity", "decision_speed", "load_balance", "tone_safety"],
};

export const SCORE_LABELS: Record<ScoreKey, string> = {
  reply_radar: "답장 레이더",
  initiative_balance: "선톡 균형",
  warmth: "온도",
  repair_reflex: "회복 반사",
  follow_through: "약속 이행",
  participation_balance: "참여 균형",
  energy: "활력",
  humor_density: "유머 밀도",
  plan_execution: "계획 실행력",
  cohesion: "결속력",
  responsiveness: "응답성",
  clarity: "명확성",
  decision_speed: "결정 속도",
  load_balance: "업무 분담",
  tone_safety: "분위기",
};

const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

/** 답장 중앙값(초) → 0~100. 1분=100, 10분=85, 1시간=60, 6시간=30, 1일+=5 (로그 스케일) */
export function replyScore(medianSec: number | null): number | null {
  if (medianSec === null) return null;
  const minutes = Math.max(1, medianSec / 60);
  const score = 100 - 25 * Math.log10(minutes); // 1분→100, 10분→75, 100분→50, 1000분→25
  return clamp(score);
}

function gini(values: number[]): number {
  const xs = values.filter((v) => v >= 0).sort((a, b) => a - b);
  const n = xs.length;
  const sum = xs.reduce((a, b) => a + b, 0);
  if (n === 0 || sum === 0) return 0;
  let acc = 0;
  xs.forEach((x, i) => (acc += (2 * (i + 1) - n - 1) * x));
  return acc / (n * sum);
}

export function computePriors(stats: ChatStats, set: ScoreSet): ScorePrior[] {
  const people = stats.perPerson;
  const totalText = Math.max(1, stats.total.textMessages);
  const laughs = people.reduce((a, p) => a + p.laughs, 0);
  const emoticons = people.reduce((a, p) => a + p.emoticons, 0);
  const questions = people.reduce((a, p) => a + p.questions, 0);
  const humor = clamp(Math.min(1, (laughs / totalText) * 0.5 + (emoticons / Math.max(1, stats.total.messages)) * 2) * 100);
  const warmth = clamp(humor * 0.6 + Math.min(100, (questions / totalText) * 300) * 0.4);
  const activeRatio = stats.period.days > 0 ? stats.period.activeDays / (stats.period.days + 1) : 1;
  const energy = clamp(activeRatio * 70 + Math.min(30, stats.sessions.avgLenMsgs));

  const out: ScorePrior[] = [];
  const push = (key: ScoreKey, prior: number | null, basis: string) => out.push({ key, label: SCORE_LABELS[key], prior, basis });

  if (set === "PAIR") {
    const slowest = people.map((p) => p.replyMedianSec).filter((x): x is number => x !== null).sort((a, b) => b - a)[0] ?? null;
    push("reply_radar", replyScore(slowest), "느린 쪽 답장 중앙값 기준 로그 스케일");
    const b = stats.balance;
    push("initiative_balance", b ? clamp(100 - Math.abs(b.initiationRatio - 0.5) * 200) : null, "선톡 비율의 균형 (50:50=100)");
    push("warmth", warmth, "ㅋ·이모티콘·질문 밀도");
    push("repair_reflex", null, "LLM: 갈등 후 복귀 사례");
    push("follow_through", null, "LLM: 계획 제안 → 실행 언급 비율");
  } else if (set === "GROUP") {
    push("participation_balance", clamp((1 - gini(people.map((p) => p.textMessages))) * 100), "텍스트 메시지 수 지니계수 역수");
    push("energy", energy, "활성일 비율·세션 길이");
    push("humor_density", humor, "ㅋ·이모티콘 밀도");
    push("plan_execution", null, "LLM: 계획 제안 → 실행");
    push("cohesion", null, "LLM: 호명·응답·공통 화제");
  } else {
    const med = people.map((p) => p.replyMedianSec).filter((x): x is number => x !== null);
    const avgMed = med.length ? med.reduce((a, b) => a + b, 0) / med.length : null;
    push("responsiveness", replyScore(avgMed), "평균 답장 중앙값");
    push("clarity", null, "LLM");
    push("decision_speed", null, "LLM");
    push("load_balance", clamp((1 - gini(people.map((p) => p.textMessages))) * 100), "텍스트 메시지 분포");
    push("tone_safety", clamp(50 + humor * 0.3), "유머 밀도 보정");
  }
  return out;
}

export function pickScoreSet(participantCount: number, focus: string): ScoreSet {
  if (focus === "WORK") return "WORK";
  return participantCount === 2 ? "PAIR" : "GROUP";
}
