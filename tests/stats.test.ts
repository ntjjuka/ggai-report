import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseUploads, type Message } from "@/lib/parser";
import { computeStats, computePriors, renderStatsFacts, allowedNumbers, type ParticipantMap } from "@/lib/stats";
import { buildTier0 } from "@/lib/tier0";

const LIMITS = { maxMessages: 300_000, minMessages: 1, maxParticipants: 60 };

function load(name: string) {
  return parseUploads([{ name, bytes: new Uint8Array(readFileSync(join(process.cwd(), "docs", "fixtures", name))) }], LIMITS);
}

function mapOf(chat: { participants: { rawName: string }[] }, uploader?: string): ParticipantMap {
  const map: ParticipantMap = new Map();
  chat.participants.forEach((p, i) => map.set(p.rawName, { id: `p${i + 1}`, name: p.rawName, rawNames: [p.rawName], isUploader: p.rawName === uploader }));
  return map;
}

function synth(lines: [string, string, string][]): Message[] {
  const text = lines.map(([at, who, body]) => `${at}, ${who} : ${body}`).join("\n");
  return parseUploads([{ name: "s.txt", bytes: new TextEncoder().encode(text) }], LIMITS).messages;
}

describe("computeStats", () => {
  it("counts kinds, participants, heatmap and monthly totals consistently", () => {
    const chat = load("android_ko_basic.txt");
    const map = mapOf(chat, "박민수");
    const s = computeStats(chat.messages, map, "p1");
    expect(s.total.messages).toBe(14); // 16 - 시스템 2
    expect(s.total.textMessages).toBe(10);
    expect(s.total.media.photo).toBe(1);
    expect(s.total.media.emoticon).toBe(1);
    expect(s.total.media.file).toBe(1);
    expect(s.total.deleted).toBe(1);
    expect(s.total.systemEvents).toBe(2);
    expect(s.rhythm.heatmap.flat().reduce((a, b) => a + b, 0)).toBe(14);
    expect(s.rhythm.monthly.reduce((a, m) => a + m.total, 0)).toBe(14);
    expect(s.perPerson.map((p) => p.id).sort()).toEqual(["p1", "p2", "p3"]);
    expect(s.balance).toBeNull(); // 3명이라 균형 없음
  });

  it("session gap boundary: 5h59 same session, 6h00 new session", () => {
    const msgs = synth([
      ["2025. 1. 1. 오전 9:00", "A", "안녕"],
      ["2025. 1. 1. 오후 2:59", "B", "응"], // +5h59 → 같은 세션, B 답장
      ["2025. 1. 1. 오후 8:59", "A", "뭐해"], // +6h00 → 새 세션, A 선톡
    ]);
    const map: ParticipantMap = new Map([
      ["A", { id: "a", name: "A", rawNames: ["A"], isUploader: true }],
      ["B", { id: "b", name: "B", rawNames: ["B"], isUploader: false }],
    ]);
    const s = computeStats(msgs, map, "a");
    expect(s.sessions.count).toBe(2);
    const a = s.perPerson.find((p) => p.id === "a")!;
    const b = s.perPerson.find((p) => p.id === "b")!;
    expect(a.initiations).toBe(2);
    expect(b.initiations).toBe(0);
    expect(b.replyCount).toBe(1);
    expect(b.replyMedianSec).toBe(359 * 60);
    expect(a.replyCount).toBe(0); // 세션 경계 넘은 건 답장이 아님
    expect(s.balance?.uploaderId).toBe("a");
    expect(s.balance!.initiationRatio).toBe(1);
  });

  it("excluded participants create context breaks that block reply attribution", () => {
    const msgs = synth([
      ["2025. 1. 1. 오전 9:00", "A", "질문"],
      ["2025. 1. 1. 오전 9:01", "C", "끼어듦"],
      ["2025. 1. 1. 오전 9:02", "B", "답"],
    ]);
    const map: ParticipantMap = new Map([
      ["A", { id: "a", name: "A", rawNames: ["A"], isUploader: true }],
      ["B", { id: "b", name: "B", rawNames: ["B"], isUploader: false }],
    ]);
    const s = computeStats(msgs, map, "a");
    expect(s.perPerson.find((p) => p.id === "b")!.replyCount).toBe(0);
  });

  it("priors, facts and tier0 are produced for a group fixture without forbidden words", () => {
    const chat = load("group_30people.txt");
    const map = mapOf(chat, "참여자01");
    const s = computeStats(chat.messages, map, "p1");
    expect(s.perPerson.length).toBe(31);
    const priors = computePriors(s, "GROUP");
    expect(priors.map((p) => p.key)).toEqual(["participation_balance", "energy", "humor_density", "plan_execution", "cohesion"]);
    const facts = renderStatsFacts(s, chat.messages, priors);
    expect(facts.length).toBeGreaterThan(10);
    expect(allowedNumbers(facts).has(s.total.messages)).toBe(true);
    const t0 = buildTier0(s, chat.messages, "seed-1");
    expect(t0.headline.length).toBeGreaterThan(3);
    expect(t0.lines.length).toBeGreaterThanOrEqual(3);
    expect(t0.awards.length).toBeLessThanOrEqual(6);
    const all = [t0.headline, ...t0.lines.map((l) => l.text), ...t0.awards.map((a) => a.reason)].join(" ");
    expect(all).not.toMatch(/뚱|못생|장애|우울증|자살/);
    expect(buildTier0(s, chat.messages, "seed-1")).toEqual(t0); // 결정적
  });

  it("pair tier0 picks one-way headline when lean is strong", () => {
    const lines: [string, string, string][] = [];
    for (let d = 1; d <= 20; d++) {
      lines.push([`2025. 1. ${d}. 오전 9:00`, "서연", "뭐해?"]);
      lines.push([`2025. 1. ${d}. 오후 1:00`, "지훈", "ㅇㅇ"]);
      lines.push([`2025. 1. ${d}. 오후 1:01`, "서연", "밥은?"]);
    }
    const msgs = synth(lines);
    const map: ParticipantMap = new Map([
      ["서연", { id: "a", name: "서연", rawNames: ["서연"], isUploader: true }],
      ["지훈", { id: "b", name: "지훈", rawNames: ["지훈"], isUploader: false }],
    ]);
    const s = computeStats(msgs, map, "a");
    expect(s.balance!.lean).toBeGreaterThan(0.3);
    const t0 = buildTier0(s, msgs, "x");
    expect(t0.relationLabel).toBe("한쪽만 달리는 사이");
    expect(t0.awards.some((a) => a.name === "읽씹 장인상")).toBe(true);
  });

  it("computes pair balance without an uploader (reference = first participant, ADR-16)", () => {
    const msgs = synth([
      ["2025. 1. 1. 오후 1:00", "서연", "안녕"],
      ["2025. 1. 1. 오후 1:05", "지훈", "응"],
      ["2025. 1. 2. 오후 1:00", "서연", "뭐해?"],
      ["2025. 1. 2. 오후 1:30", "지훈", "일"],
    ]);
    const map: ParticipantMap = new Map([
      ["서연", { id: "a", name: "서연", rawNames: ["서연"], isUploader: false }],
      ["지훈", { id: "b", name: "지훈", rawNames: ["지훈"], isUploader: false }],
    ]);
    expect(computeStats(msgs, map, null).balance?.uploaderId).toBe("a");
    expect(computeStats(msgs, map, "b").balance?.uploaderId).toBe("b");
    expect(computeStats(msgs, map, "zzz").balance?.uploaderId).toBe("a"); // 모르는 ID는 폴백
  });

  it("gives each badge to at most one person in a big group (no '답장요정 ×7')", () => {
    const names = Array.from({ length: 11 }, (_, i) => `사람${i + 1}`);
    const lines: [string, string, string][] = [];
    for (let d = 1; d <= 20; d++) for (let i = 0; i < 11; i++) for (let k = 0; k < 3; k++) lines.push([`2025. 1. ${d}. 오후 ${1 + ((i + k) % 8)}:${String((i * 7 + k * 3) % 60).padStart(2, "0")}`, names[i], `메시지 ${d}-${i}-${k} ㅋㅋ 뭐해?`]);
    const msgs = synth(lines);
    const map: ParticipantMap = new Map(names.map((n, i) => [n, { id: `p${i + 1}`, name: n, rawNames: [n], isUploader: i === 0 }]));
    const s = computeStats(msgs, map, "p1");
    const t0 = buildTier0(s, msgs, "x");
    const ids = t0.badges.map((b) => b.badgeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(t0.badges.length).toBeLessThanOrEqual(8);
  });
});

describe("pickMood", () => {
  it("never picks the dry or warm mood at random; warm only when forced by safety flags", async () => {
    const { pickMood } = await import("@/lib/report/moods");
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(pickMood(`r${i}`));
    expect([...seen].sort()).toEqual(["DIRECT", "HYPED"]);
    expect(pickMood("r1", true)).toBe("WARM");
  });
});
