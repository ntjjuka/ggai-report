import { MOOD, type Mood } from "./schema";
import { hashSeed } from "@/lib/tier0/templates";

const WEIGHTS: Record<Mood, number> = { DIRECT: 40, WARM: 25, DRY: 20, HYPED: 15 };

/** 보고서 ID로 결정되는 가중 랜덤 기분. 민감 신호가 있으면 WARM 강제. */
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
