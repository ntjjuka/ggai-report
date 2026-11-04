import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ParseError, parseUploads, parseTexts, decodeBytes, extractTextEntries } from "@/lib/parser";
import { classifyBody } from "@/lib/parser/kakaoParser";
import { isBlobLike } from "@/lib/parser/patterns";
import { zipSync, strToU8 } from "fflate";
import { isBotSender } from "@/lib/parser/patterns";

const FIXTURES = join(process.cwd(), "docs", "fixtures");
const LIMITS = { maxMessages: 300_000, minMessages: 1, maxParticipants: 60 };

interface Expected {
  error?: string;
  title?: string | null;
  sourceFormat?: string;
  messageCount?: number;
  participants?: unknown[];
  warnings?: Record<string, unknown>;
  messages?: unknown[];
}

function loadInputs(stem: string) {
  const dir = join(FIXTURES, stem);
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    return readdirSync(dir)
      .filter((f) => /\.(txt|csv)$/.test(f))
      .map((f) => ({ name: f, bytes: new Uint8Array(readFileSync(join(dir, f))) }));
  }
  for (const ext of [".txt", ".csv"]) {
    const p = join(FIXTURES, stem + ext);
    if (statSync(p, { throwIfNoEntry: false })) return [{ name: stem + ext, bytes: new Uint8Array(readFileSync(p)) }];
  }
  throw new Error(`no input for ${stem}`);
}

describe("parser golden (docs/fixtures/*.expected.json)", () => {
  const expectedFiles = readdirSync(FIXTURES).filter((f) => f.endsWith(".expected.json"));
  expect(expectedFiles.length).toBeGreaterThanOrEqual(12);
  for (const file of expectedFiles) {
    const stem = file.replace(".expected.json", "");
    it(stem, () => {
      const expected: Expected = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
      const inputs = loadInputs(stem);
      if (expected.error) {
        expect(() => parseUploads(inputs, LIMITS)).toThrowError(expect.objectContaining({ code: expected.error }));
        return;
      }
      const actual = parseUploads(inputs, LIMITS);
      expect(actual.title).toBe(expected.title);
      expect(actual.sourceFormat).toBe(expected.sourceFormat);
      expect(actual.messageCount).toBe(expected.messageCount);
      expect(actual.warnings).toEqual(expected.warnings);
      expect(actual.participants).toEqual(expected.participants);
      expect(actual.messages).toEqual(expected.messages);
    });
  }
});

describe("parser rules", () => {
  it("is deterministic", () => {
    const inputs = loadInputs("android_ko_basic");
    const a = parseUploads(inputs, LIMITS);
    const b = parseUploads(inputs, LIMITS);
    expect(a).toEqual(b);
  });

  it("12h conversion: 오전 12→0, 오후 12→12, 오후 1→13, 오전 8→8", () => {
    const raw = [
      "2025. 1. 1. 오전 12:00, A : 자정",
      "2025. 1. 1. 오후 12:00, B : 정오",
      "2025. 1. 1. 오후 1:00, A : 오후한시",
      "2025. 1. 1. 오전 8:00, B : 아침",
    ].join("\n");
    const r = parseTexts([{ name: "x.txt", text: raw }], LIMITS);
    expect(r.messages.map((m) => m.at.slice(11))).toEqual(["00:00", "12:00", "13:00", "08:00"]);
  });

  it("rejects too few messages / too many participants", () => {
    const raw = "2025. 1. 1. 오후 1:00, A : 안녕\n2025. 1. 1. 오후 1:01, B : 하이";
    expect(() => parseTexts([{ name: "x.txt", text: raw }], { ...LIMITS, minMessages: 30 })).toThrowError(
      expect.objectContaining({ code: "TOO_FEW_MESSAGES" }),
    );
    const many = Array.from({ length: 70 }, (_, i) => `2025. 1. 1. 오후 1:${String(i % 60).padStart(2, "0")}, 이름${i} : 메시지`).join("\n");
    expect(() => parseTexts([{ name: "x.txt", text: many }], LIMITS)).toThrowError(
      expect.objectContaining({ code: "TOO_MANY_PARTICIPANTS" }),
    );
  });

  it("decodes UTF-16LE with BOM and rejects undecodable bytes", () => {
    const text = "2025. 1. 1. 오후 1:00, A : 안녕";
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(decodeBytes(new Uint8Array(utf16)).text).toBe(text);
    expect(() => decodeBytes(new Uint8Array([0xff, 0xff, 0xfe, 0x00, 0x80, 0x81]))).toThrowError(ParseError);
  });

  it("zip: extracts only txt/csv, rejects path traversal", () => {
    const ok = zipSync({ "KakaoTalkChats.txt": strToU8("2025. 1. 1. 오후 1:00, A : 안녕\n"), "photo.jpg": new Uint8Array([1, 2, 3]) });
    const entries = extractTextEntries(ok);
    expect(entries.map((e) => e.name)).toEqual(["KakaoTalkChats.txt"]);
    const bad = zipSync({ "../etc/passwd.txt": strToU8("x") });
    expect(() => extractTextEntries(bad)).toThrowError(expect.objectContaining({ code: "ZIP_UNSAFE_ENTRY" }));
    expect(() => parseUploads([{ name: "a.zip", bytes: ok }], LIMITS)).not.toThrow();
  });

  it("detects kakao system bots by sender name (docs/18 P1-2)", () => {
    for (const n of ["오픈채팅봇", "채팅봇", "플레이봇", "오픈채팅 봇", " 플레이봇 "]) expect(isBotSender(n)).toBe(true);
    for (const n of ["봇", "로봇", "채팅봇2", "김봇", "민수"]) expect(isBotSender(n)).toBe(false);
    const text = ["2025. 1. 1. 오후 1:00, 김하늘 : 안녕", "2025. 1. 1. 오후 1:01, 플레이봇 : 오늘의 운세", "2025. 1. 1. 오후 1:02, 박민수 : ㅇㅇ"].join("\n");
    const chat = parseTexts([{ name: "x.txt", text }], LIMITS);
    expect(chat.messages.find((m) => m.sender === "플레이봇")?.kind).toBe("BOT");
  });

  it("handles a 150k-message export without RangeError (full phone export)", () => {
    const names = ["김하늘", "박민수", "이서연"];
    const lines: string[] = ["김하늘 님과 카카오톡 대화", "저장한 날짜 : 2025년 1월 1일 오후 1:00", ""];
    for (let i = 0; i < 150_000; i++) {
      if (i % 400 === 0) lines.push(`--------------- 2025년 ${1 + Math.floor(i / 12000) % 12}월 ${1 + (Math.floor(i / 400) % 28)}일 수요일 ---------------`);
      lines.push(`2025. ${1 + Math.floor(i / 12000) % 12}. ${1 + (Math.floor(i / 400) % 28)}. 오후 ${1 + (i % 11)}:${String(i % 60).padStart(2, "0")}, ${names[i % 3]} : 메시지 ${i}`);
    }
    const chat = parseTexts([{ name: "KakaoTalkChats.txt", text: lines.join("\n") }], LIMITS);
    expect(chat.messages.length).toBe(150_000);
    expect(chat.participants.length).toBe(3);
  });

  it("rejects unsupported file types", () => {
    expect(() => parseUploads([{ name: "a.docx", bytes: new Uint8Array([1]) }], LIMITS)).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_FILE_TYPE" }),
    );
  });
});

describe("data blobs (hex dumps, hashes, base64, logs) are not conversation", () => {
  it("classifies blob-like bodies as DATA and keeps real text as TEXT", () => {
    const hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";
    expect(isBlobLike(hex)).toBe(true);
    expect(classifyBody(hex).kind).toBe("DATA");
    expect(classifyBody("iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==").kind).toBe("DATA");
    expect(classifyBody("[12:01:33.004] ERROR 0x7ffe 0x0001 0x0002 0x0003 0x0004 0x0005 0x0006 0x0007 0x0008 0x0009 0x000a 0x000b 0x000c 0x000d 0x000e 0x000f 0x0010 0x0011 0x0012").kind).toBe("DATA");
    // 사람 말·URL·짧은 코드는 그대로 텍스트
    expect(classifyBody("오늘 회의 몇 시지? 어제 올린 자료 봤는데 3페이지 숫자가 좀 이상한 것 같아서 다시 확인 부탁할게").kind).toBe("TEXT");
    expect(classifyBody("https://www.example.com/path/to/some/very/long/resource/that/keeps/going/on/and/on/forever/index.html").kind).toBe("TEXT");
    expect(classifyBody("커밋은 a1b2c3d 로 올렸어").kind).toBe("TEXT");
    expect(isBlobLike("ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ")).toBe(false);
  });
});
