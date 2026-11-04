import { MOOD, type Mood } from "./schema";
import { hashSeed } from "@/lib/tier0/templates";

// 2026-11-03: 건조·다정이 뽑히면 밈·과장이 반으로 줄어 "분석 리포트"처럼 읽힌다(실측) → 랜덤은 직진/들뜸만, 다정은 민감 신호 때만
// 2026-11-04: 직진 고정. 들뜸(장치 최대·격차 비유 문단당 2개)은 할당량 코미디를 더 번잡하게 만들어 뺐다(docs/14 §10). 다정은 안전 신호 때만(pickMood 인자)
const WEIGHTS: Record<Mood, number> = { DIRECT: 100, WARM: 0, DRY: 0, HYPED: 0 };

/** 보고서 ID로 결정되는 가중 랜덤 기분(직진 55 / 들뜸 45). 민감 신호가 있으면 WARM 강제. */
export function pickMood(seedKey: string, forceWarm = false): Mood {
  if (forceWarm) return "WARM";
  const r = hashSeed(seedKey) % 100;
  let acc = 0;
  for (const m of MOOD) {
    acc += WEIGHTS[m];
    if (r < acc) return m;
  }
  return "DIRECT";
}

export const SIGNATURES = [
  "보고 끝. 결재는 네가 해.",
  "스크린샷은 자유, 반박은 카톡으로.",
  "내 말이 틀렸으면 둘이 잘 지내고 있다는 뜻이니까, 그것도 좋은 소식.",
  "다음 떡볶이는 네가 사.",
];

export function pickSignature(seedKey: string, participantCount: number): string {
  const idx = hashSeed(seedKey + ":sig") % SIGNATURES.length;
  const s = SIGNATURES[idx];
  return participantCount > 2 ? s.replace("둘이 잘 지내고", "다들 잘 지내고") : s;
}

export const SHARE_EMOJIS = ["📮", "📋", "🔍", "☕", "🧾", "📌"];
export function pickShareEmoji(seedKey: string): string {
  return SHARE_EMOJIS[hashSeed(seedKey + ":emoji") % SHARE_EMOJIS.length];
}
