// 전사 압축 효과 측정: 옛 형식(줄마다 전체 시각·이름) vs 압축 형식 토큰 추정 비교
// 사용: pnpm tsx scripts/transcript-savings.ts <내보내기.txt>
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseUploads } from "@/lib/parser";
import { buildTranscript, estimateTokens, renderTranscript } from "@/lib/report";
import { toEffectiveMessages, type ParticipantMap } from "@/lib/stats";

const file = process.argv[2];
if (!file) throw new Error("사용: pnpm tsx scripts/transcript-savings.ts <파일>");
const chat = parseUploads([{ name: basename(file), bytes: new Uint8Array(readFileSync(file)) }], { maxMessages: 1_000_000, minMessages: 1, maxParticipants: 60 });
const map: ParticipantMap = new Map(chat.participants.map((p, i) => [p.rawName, { id: `p${i + 1}`, name: p.rawName, rawNames: [p.rawName], isUploader: i === 0 }]));
const t = buildTranscript(toEffectiveMessages(chat.messages, map), map);
const oldTokens = t.reduce((a, m) => a + estimateTokens(`${m.id} [${m.at.replace("T", " ")}] ${m.name}${m.isUploader ? "(나)" : ""}: ${m.text}`), 0);
const text = renderTranscript(t);
const newTokens = estimateTokens(text);
console.log(`${basename(file)}: 메시지 ${t.length.toLocaleString()}개 · 옛 전사 ≈ ${oldTokens.toLocaleString()} 토큰 → 압축 전사 ≈ ${newTokens.toLocaleString()} 토큰 (${Math.round((1 - newTokens / oldTokens) * 100)}% 절감) · 줄 수 ${text.split("\n").length.toLocaleString()}`);
console.log(text.split("\n").slice(0, 12).join("\n"));
