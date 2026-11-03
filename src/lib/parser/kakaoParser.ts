// 카카오톡 내보내기 파서 — docs/03 §3 상태 머신의 TypeScript 구현.
// 참조 구현: docs/tools/spec_parser_prototype.py (fixtures/*.expected.json 과 동일 결과를 내야 한다)
import { parseCsvRows } from "./csv";
import { decodeBytes } from "./encoding";
import * as P from "./patterns";
import { extractTextEntries } from "./zip";
import {
  DEFAULT_PARSE_LIMITS,
  ParseError,
  type Message,
  type MessageKind,
  type NamedBytes,
  type NamedText,
  type ParseLimits,
  type ParseWarnings,
  type ParsedChat,
  type ParticipantSummary,
  type SourceFormat,
} from "./types";

type Ampm = "오전" | "오후" | "am" | "pm" | undefined;

interface Clock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

function to24h(ampm: Ampm, hour: number): number {
  if (ampm === "오전" || ampm === "am") return hour === 12 ? 0 : hour;
  if (ampm === "오후" || ampm === "pm") return hour === 12 ? 12 : hour + 12;
  return hour;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatAt(c: Clock): string {
  return `${c.y}-${pad2(c.mo)}-${pad2(c.d)}T${pad2(c.h)}:${pad2(c.mi)}`;
}

function clock(y: string, mo: string, d: string, ampm: Ampm, h: string, mi: string): Clock {
  return { y: Number(y), mo: Number(mo), d: Number(d), h: to24h(ampm, Number(h)), mi: Number(mi) };
}

export function classifyBody(body: string): { kind: MessageKind; text: string; fileName: string | null } {
  const b = body.trim();
  if (P.DELETED_MARKER.test(b)) return { kind: "DELETED", text: b, fileName: null };
  if (P.PHOTO_RE.test(b)) return { kind: "PHOTO", text: b, fileName: null };
  if (b in P.MEDIA_EXACT) return { kind: P.MEDIA_EXACT[b], text: b, fileName: null };
  const f = P.FILE_RE.exec(b);
  if (f) return { kind: "FILE", text: b, fileName: f[2].trim() };
  if (!b) return { kind: "EMPTY", text: "", fileName: null };
  if (P.isBlobLike(b)) return { kind: "DATA", text: b, fileName: null };
  return { kind: "TEXT", text: b, fileName: null };
}

export function classifySystem(text: string): MessageKind {
  if (P.SYS_JOIN.test(text) || P.SYS_JOIN_EN.test(text)) return "SYSTEM_JOIN";
  if (P.SYS_LEAVE.test(text) || P.SYS_LEAVE_EN.test(text)) return "SYSTEM_LEAVE";
  if (P.SYS_INVITE.test(text) || P.SYS_INVITE_EN.test(text)) return "SYSTEM_INVITE";
  if (P.SYS_KICK.test(text)) return "SYSTEM_KICK";
  if (P.DELETED_MARKER.test(text)) return "DELETED";
  return "SYSTEM_OTHER";
}

function isBareSystemLine(s: string): boolean {
  return (
    P.SYS_JOIN.test(s) ||
    P.SYS_LEAVE.test(s) ||
    P.SYS_INVITE.test(s) ||
    P.SYS_KICK.test(s) ||
    P.DELETED_MARKER.test(s) ||
    P.SYS_INVITE_EN.test(s) ||
    P.SYS_JOIN_EN.test(s) ||
    P.SYS_LEAVE_EN.test(s)
  );
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/** docs/03 §3.1 포맷 자동 감지 (첫 1,000줄 최다 매치) */
export function detectFormat(lines: string[]): SourceFormat {
  const first = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
  if (P.CSV_HEADER_RE.test(first)) return "KAKAO_CSV";
  const counts: Record<Exclude<SourceFormat, "KAKAO_CSV">, number> = {
    KAKAO_ANDROID_KO: 0,
    KAKAO_IOS_DOTTED: 0,
    KAKAO_PC_BRACKET: 0,
    KAKAO_EN: 0,
  };
  for (const line of lines.slice(0, 1000)) {
    if (P.MSG_A.test(line)) counts.KAKAO_ANDROID_KO++;
    else if (P.MSG_B.test(line)) counts.KAKAO_IOS_DOTTED++;
    else if (P.MSG_C.test(line)) counts.KAKAO_PC_BRACKET++;
    else if (P.MSG_E.test(line)) counts.KAKAO_EN++;
  }
  let best: Exclude<SourceFormat, "KAKAO_CSV"> = "KAKAO_ANDROID_KO";
  for (const k of Object.keys(counts) as (keyof typeof counts)[]) {
    if (counts[k] > counts[best]) best = k;
  }
  if (counts[best] === 0) throw new ParseError("NO_MESSAGES");
  return best;
}

interface FileParseResult {
  title: string | null;
  messages: Omit<Message, "index">[];
  warnings: Pick<ParseWarnings, "orphanLines" | "unknownSystemLines" | "dateUnknownBeforeSeparator">;
}

function makeMessage(at: string, sender: string | null, kind: MessageKind, text: string, fileName: string | null): Omit<Message, "index"> {
  return {
    at,
    sender,
    kind,
    text,
    fileName,
    hasLink: P.URL_RE.test(text),
    mentions: kind === "TEXT" ? [...text.matchAll(P.MENTION_RE)].map((m) => m[1]) : [],
  };
}

/** 파일 1개(디코딩된 텍스트)를 상태 머신으로 파싱 (docs/03 §3) */
export function parseText(text: string, fmt: SourceFormat): FileParseResult {
  const lines = splitLines(text);
  const messages: Omit<Message, "index">[] = [];
  const warnings = { orphanLines: 0, unknownSystemLines: 0, dateUnknownBeforeSeparator: 0 };
  let title: string | null = null;
  const bareSepsOk = fmt === "KAKAO_ANDROID_KO" || fmt === "KAKAO_IOS_DOTTED" || fmt === "KAKAO_EN";
  let curDate: { y: number; mo: number; d: number } | null = null;
  let cur: { c: Clock; sender: string; lines: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const body = cur.lines.join("\n").trim();
    const cls = classifyBody(body);
    const kind: MessageKind = P.isBotSender(cur.sender) ? "BOT" : cls.kind;
    messages.push(makeMessage(formatAt(cur.c), cur.sender, kind, cls.text, cls.fileName));
    cur = null;
  };
  const system = (c: Clock, body: string) => {
    const kind = classifySystem(body);
    if (kind === "SYSTEM_OTHER") warnings.unknownSystemLines += 1;
    messages.push(makeMessage(formatAt(c), null, kind, body, null));
  };
  const setDate = (y: string, mo: string, d: string) => {
    curDate = { y: Number(y), mo: Number(mo), d: Number(d) };
  };

  for (const raw of lines) {
    const line = raw.startsWith("﻿") ? raw.slice(1) : raw;
    const s = line.trim();
    let m: RegExpExecArray | null;

    // 1) 헤더 — cur 상태와 무관하게 인식, 본문 병합 금지
    if (s && (P.HEADER_SAVED_AT.test(s) || P.HEADER_SPLIT_FILE.test(s) || P.HEADER_TITLE_EN.test(s) || P.HEADER_TITLE_KO.test(s))) {
      flush();
      if (title === null && !P.HEADER_SAVED_AT.test(s)) {
        const ko = P.HEADER_TITLE_KO.exec(s);
        if (ko) title = ko[1];
        else if (P.HEADER_TITLE_EN.test(s)) title = s.slice("KakaoTalk Chats".length).trim() || null;
      }
      continue;
    }
    // 2) 대시 날짜 구분선
    if ((m = P.DATE_SEP_DASH.exec(s))) {
      flush();
      setDate(m[1], m[2], m[3]);
      continue;
    }
    // 3) 대시 없는 구분선 — 우세 포맷 A/B/E 에서만
    if (bareSepsOk) {
      m = P.DATE_SEP_BARE.exec(s) ?? (fmt === "KAKAO_IOS_DOTTED" ? P.DATE_SEP_DOTTED.exec(s) : null);
      if (m) {
        flush();
        setDate(m[1], m[2], m[3]);
        continue;
      }
      if ((m = P.TIME_ONLY_KO.exec(s) ?? P.TIME_ONLY_DOTTED.exec(s))) {
        flush();
        setDate(m[1], m[2], m[3]);
        continue;
      }
      if ((m = P.TIME_ONLY_EN.exec(s))) {
        flush();
        setDate(m[3], String(P.MONTH_NUM[m[2]]), m[1]);
        continue;
      }
    }
    // 4) 메시지 A/B/E
    if ((m = P.MSG_A.exec(line) ?? P.MSG_B.exec(line))) {
      flush();
      const c = clock(m[1], m[2], m[3], m[4] as Ampm, m[5], m[6]);
      curDate = { y: c.y, mo: c.mo, d: c.d };
      cur = { c, sender: m[7].trim(), lines: [m[8]] };
      continue;
    }
    if ((m = P.MSG_E.exec(line))) {
      flush();
      const c = clock(m[3], String(P.MONTH_NUM[m[2]]), m[1], m[6] as Ampm, m[4], m[5]);
      curDate = { y: c.y, mo: c.mo, d: c.d };
      cur = { c, sender: m[7].trim(), lines: [m[8]] };
      continue;
    }
    // 5) 날짜접두 + 콤마, 구분자 없음 → 시스템
    if ((m = P.SYS_A.exec(line) ?? P.SYS_B.exec(line))) {
      flush();
      system(clock(m[1], m[2], m[3], m[4] as Ampm, m[5], m[6]), m[7].trim());
      continue;
    }
    if ((m = P.SYS_E.exec(line))) {
      flush();
      system(clock(m[3], String(P.MONTH_NUM[m[2]]), m[1], m[6] as Ampm, m[4], m[5]), m[7].trim());
      continue;
    }
    // 6) 메시지 C (대괄호) — 날짜는 구분선에서만
    if ((m = P.MSG_C.exec(line))) {
      flush();
      if (!curDate) {
        warnings.dateUnknownBeforeSeparator += 1;
        continue;
      }
      const c: Clock = { y: curDate.y, mo: curDate.mo, d: curDate.d, h: to24h(m[2] as Ampm, Number(m[3])), mi: Number(m[4]) };
      cur = { c, sender: m[1].trim(), lines: [m[5]] };
      continue;
    }
    // 7) 날짜·대괄호 없는 단독 시스템 줄
    if (s && isBareSystemLine(s)) {
      flush();
      const last = messages[messages.length - 1];
      const c: Clock = last
        ? parseAt(last.at)
        : curDate
          ? { y: curDate.y, mo: curDate.mo, d: curDate.d, h: 0, mi: 0 }
          : { y: 1970, mo: 1, d: 1, h: 0, mi: 0 };
      system(c, s);
      continue;
    }
    // 8) 빈 줄 — 멀티라인 내부 빈 줄 보존
    if (!s) {
      if (cur) cur.lines.push("");
      continue;
    }
    // 9) 멀티라인 연속 / 고아 줄
    if (cur) cur.lines.push(line);
    else warnings.orphanLines += 1;
  }
  flush();
  return { title, messages, warnings };
}

export function parseAt(at: string): Clock {
  return { y: Number(at.slice(0, 4)), mo: Number(at.slice(5, 7)), d: Number(at.slice(8, 10)), h: Number(at.slice(11, 13)), mi: Number(at.slice(14, 16)) };
}

/** docs/03 §3.2 CSV(Date,User,Message) */
export function parseCsv(text: string): FileParseResult {
  const rows = parseCsvRows(text.replace(/^﻿/, ""));
  if (rows.length === 0 || !P.CSV_HEADER_RE.test(rows[0].join(","))) throw new ParseError("NO_MESSAGES");
  const header = rows[0].map((c) => c.trim().toLowerCase());
  const di = header.indexOf("date");
  const ui = header.indexOf("user");
  const mi = header.indexOf("message");
  const messages: Omit<Message, "index">[] = [];
  for (const row of rows.slice(1)) {
    if (row.length <= Math.max(di, ui, mi)) continue;
    const dm = P.CSV_DATE_RE.exec(row[di] ?? "");
    const author = (row[ui] ?? "").trim();
    if (!dm || !author) continue;
    const c: Clock = { y: Number(dm[1]), mo: Number(dm[2]), d: Number(dm[3]), h: Number(dm[4]), mi: Number(dm[5]) };
    const cls = classifyBody(row[mi] ?? "");
    const kind: MessageKind = P.isBotSender(author) ? "BOT" : cls.kind;
    messages.push(makeMessage(formatAt(c), author, kind, cls.text, cls.fileName));
  }
  return { title: null, messages, warnings: { orphanLines: 0, unknownSystemLines: 0, dateUnknownBeforeSeparator: 0 } };
}

/** 경계 중복 제거: (at, sender, text) 연속 동일 → 1개 */
function dedupeConsecutive(messages: Omit<Message, "index">[]): { messages: Omit<Message, "index">[]; removed: number } {
  const out: Omit<Message, "index">[] = [];
  let removed = 0;
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.at === m.at && prev.sender === m.sender && prev.text === m.text) {
      removed += 1;
      continue;
    }
    out.push(m);
  }
  return { messages: out, removed };
}

/** 파일명 자연 정렬 (…-1.txt, -2.txt, -10.txt) */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** 디코딩된 텍스트 파일들을 파일별로 파싱 → 연결 → 중복 제거 → 참여자 집계 (docs/03 §1, §3) */
export function parseTexts(files: NamedText[], limits: ParseLimits = DEFAULT_PARSE_LIMITS, encodingFallback = false): ParsedChat {
  if (files.length === 0) throw new ParseError("NO_MESSAGES");
  const sorted = [...files].sort((a, b) => naturalCompare(a.name, b.name));
  let title: string | null = null;
  let fmt: SourceFormat | null = null;
  const all: Omit<Message, "index">[] = [];
  const warn = { orphanLines: 0, unknownSystemLines: 0, dateUnknownBeforeSeparator: 0 };
  for (const f of sorted) {
    const lines = splitLines(f.text);
    let fileFmt: SourceFormat;
    try {
      fileFmt = detectFormat(lines);
    } catch (e) {
      if (e instanceof ParseError && e.code === "NO_MESSAGES" && sorted.length > 1) continue; // 메시지 없는 분할 파일은 건너뜀
      throw e;
    }
    fmt = fmt ?? fileFmt;
    const r = fileFmt === "KAKAO_CSV" ? parseCsv(f.text) : parseText(f.text, fileFmt);
    title = title ?? r.title;
    for (const m of r.messages) all.push(m); // spread(push(...arr))는 10만 개 넘는 배열에서 RangeError
    warn.orphanLines += r.warnings.orphanLines;
    warn.unknownSystemLines += r.warnings.unknownSystemLines;
    warn.dateUnknownBeforeSeparator += r.warnings.dateUnknownBeforeSeparator;
  }
  if (!fmt) throw new ParseError("NO_MESSAGES");
  const { messages: deduped, removed } = dedupeConsecutive(all);
  if (deduped.length === 0) throw new ParseError("NO_MESSAGES");
  const messages: Message[] = deduped.map((m, index) => ({ index, ...m }));
  let nonMonotonic = 0;
  for (let i = 1; i < messages.length; i++) if (messages[i].at < messages[i - 1].at) nonMonotonic += 1;

  const participants = summarizeParticipants(messages);
  if (messages.length > limits.maxMessages) throw new ParseError("TOO_MANY_MESSAGES");
  if (participants.length > limits.maxParticipants) throw new ParseError("TOO_MANY_PARTICIPANTS");
  const countable = messages.filter((m) => m.sender !== null && m.kind !== "BOT" && !m.kind.startsWith("SYSTEM")).length;
  if (countable < limits.minMessages) throw new ParseError("TOO_FEW_MESSAGES");

  return {
    title,
    sourceFormat: fmt,
    messageCount: messages.length,
    participants,
    warnings: { ...warn, encodingFallback, dedupedCount: removed, nonMonotonicTimestamp: nonMonotonic },
    messages,
  };
}

export function summarizeParticipants(messages: Message[]): ParticipantSummary[] {
  const map = new Map<string, ParticipantSummary>();
  for (const m of messages) {
    if (m.sender === null || m.kind === "BOT" || m.kind.startsWith("SYSTEM")) continue;
    const p = map.get(m.sender);
    if (p) {
      p.messageCount += 1;
      p.lastAt = m.at;
    } else {
      map.set(m.sender, { rawName: m.sender, messageCount: 1, firstAt: m.at, lastAt: m.at });
    }
  }
  return [...map.values()];
}

/** 바이트 입력(txt/csv/zip) → 디코딩된 텍스트 파일 목록 (원문 보관·재파싱의 정본) */
export function decodeUploads(files: NamedBytes[]): { texts: NamedText[]; encodingFallback: boolean } {
  const texts: NamedText[] = [];
  let fallback = false;
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".zip")) {
      for (const e of extractTextEntries(f.bytes)) {
        const d = decodeBytes(e.bytes);
        fallback = fallback || d.fallbackUsed;
        texts.push({ name: e.name, text: d.text });
      }
    } else if (lower.endsWith(".txt") || lower.endsWith(".csv")) {
      const d = decodeBytes(f.bytes);
      fallback = fallback || d.fallbackUsed;
      texts.push({ name: f.name, text: d.text });
    } else {
      throw new ParseError("UNSUPPORTED_FILE_TYPE", f.name);
    }
  }
  return { texts, encodingFallback: fallback };
}

/** 바이트 입력(txt/csv/zip)을 디코딩해 파싱. 업로드 진입점. */
export function parseUploads(files: NamedBytes[], limits: ParseLimits = DEFAULT_PARSE_LIMITS): ParsedChat {
  const { texts, encodingFallback } = decodeUploads(files);
  return parseTexts(texts, limits, encodingFallback);
}
