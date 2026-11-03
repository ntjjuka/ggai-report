#!/usr/bin/env python3
"""03-kakao-export-format-spec.md 의 정규식·상태 머신을 그대로 옮긴 참조 프로토타입.

용도: (1) 명세 검증 (2) Java 구현 결과와 비교할 기대값(expected.json) 생성.
실행: python3 -I spec_parser_prototype.py <fixtures_dir> [--write-expected]
Java 구현이 정본이며, 이 스크립트는 명세의 '동작 예시'다.
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
from dataclasses import dataclass, asdict, field
from datetime import datetime
from pathlib import Path

MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"
MONTH_NUM = {m: i + 1 for i, m in enumerate(MONTHS.split("|"))}

# ── 헤더 ─────────────────────────────────────────────────────────────
HEADER_TITLE_KO = re.compile(r"^(.+?)\s*(님과|와|과)?\s*카카오톡 대화\s*$")
HEADER_TITLE_EN = re.compile(r"^KakaoTalk Chats\b.*$")
HEADER_SAVED_AT = re.compile(r"^(저장한 날짜|Date Saved)\s*:\s*(.+)$")
HEADER_SPLIT_FILE = re.compile(r"^(Talk_.+\.txt|KakaoTalkChats.*\.txt)$")
# ── 날짜 구분선 ──────────────────────────────────────────────────────
DATE_SEP_DASH = re.compile(r"^-{3,}\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s+[일월화수목금토]요일)?\s*-{3,}\s*$")
DATE_SEP_BARE = re.compile(r"^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s+[일월화수목금토]요일\s*$")
DATE_SEP_DOTTED = re.compile(r"^(?:-{3,}\s*)?(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?(?:\s+[일월화수목금토]요일)?(?:\s*-{3,})?\s*$")
TIME_ONLY_KO = re.compile(r"^(\d{4})년 (\d{1,2})월 (\d{1,2})일 (오전|오후) (\d{1,2}):(\d{2})$")
TIME_ONLY_DOTTED = re.compile(r"^(\d{4})\. (\d{1,2})\. (\d{1,2})\. (?:(오전|오후) )?(\d{1,2}):(\d{2})$")
TIME_ONLY_EN = re.compile(rf"^(\d{{1,2}}) ({MONTHS}) (\d{{4}}) at (\d{{1,2}}):(\d{{2}}) (am|pm)$")
# ── 메시지 ───────────────────────────────────────────────────────────
SEP = r",\s(.+?)\s:(?:\s|$)([\s\S]*)$"          # 발신자/본문: 첫 ' : ' (본문 비어있으면 ' :' 로 끝날 수 있음)
MSG_A = re.compile(r"^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s+(?:(오전|오후)\s*)?(\d{1,2}):(\d{2})" + SEP)
MSG_B = re.compile(r"^(\d{4})\.\s(\d{1,2})\.\s(\d{1,2})\.\s(?:(오전|오후)\s)?(\d{1,2}):(\d{2})" + SEP)
MSG_C = re.compile(r"^\[(.+?)\]\s\[(?:(오전|오후)\s?)?(\d{1,2}):(\d{2})\]\s?(.*)$")
MSG_E = re.compile(rf"^(\d{{1,2}})\s({MONTHS})\s(\d{{4}})\sat\s(\d{{1,2}}):(\d{{2}})\s(am|pm)" + SEP)
# 날짜접두 + ', ' 있고 ' : ' 없음 → 시스템 줄
SYS_A = re.compile(r"^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s+(?:(오전|오후)\s*)?(\d{1,2}):(\d{2}),\s(.+)$")
SYS_B = re.compile(r"^(\d{4})\.\s(\d{1,2})\.\s(\d{1,2})\.\s(?:(오전|오후)\s)?(\d{1,2}):(\d{2}),\s(.+)$")
SYS_E = re.compile(rf"^(\d{{1,2}})\s({MONTHS})\s(\d{{4}})\sat\s(\d{{1,2}}):(\d{{2}})\s(am|pm),\s(.+)$")
# ── 시스템 분류 ──────────────────────────────────────────────────────
SYS_JOIN = re.compile(r"^(.{1,60}?)님이 들어왔습니다\.?$")
SYS_LEAVE = re.compile(r"^(.{1,60}?)님이 (채팅방을 )?나갔습니다\.?$")
SYS_INVITE = re.compile(r"^(.{1,60}?)님이 (.+?)님을 초대했습니다\.?$")
SYS_KICK = re.compile(r"^(.{1,60}?)님을 내보냈습니다\.?$")
SYS_INVITE_EN = re.compile(r"^(.+?) invited (.+)\.$")
SYS_JOIN_EN = re.compile(r"^(.+?) joined( this chatroom)?\.$")
SYS_LEAVE_EN = re.compile(r"^(.+?) left( this chatroom)?\.$")
DELETED_MARKER = re.compile(r"^(메시지가 삭제되었습니다\.|삭제된 메시지입니다\.|The message has been deleted\.)$")
# ── 미디어 ───────────────────────────────────────────────────────────
PHOTO_RE = re.compile(r"^(사진( \d{1,2}장)?|<사진 읽지 않음>|Photo)$")
FILE_RE = re.compile(r"^(파일|File):\s*(.+)$")
MEDIA_EXACT = {"동영상": "VIDEO", "<동영상 읽지 않음>": "VIDEO", "Video": "VIDEO",
               "이모티콘": "EMOTICON", "(이모티콘)": "EMOTICON", "Emoticon": "EMOTICON",
               "음성메시지": "VOICE", "Voice message": "VOICE", "지도": "MAP", "연락처": "CONTACT"}
URL_RE = re.compile(r"https?://\S+")
MENTION_RE = re.compile(r"@(\S{1,20})")
CSV_HEADER_RE = re.compile(r'^"?date"?\s*,\s*"?user"?\s*,\s*"?message"?$', re.I)
CSV_DATE_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?")


@dataclass
class Message:
    index: int
    at: str
    sender: str | None
    kind: str
    text: str
    fileName: str | None = None
    hasLink: bool = False
    mentions: list[str] = field(default_factory=list)


class ParseError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code} {detail}")
        self.code = code


def to_24h(ampm: str | None, hour: int) -> int:
    if ampm in ("오전", "am"):
        return 0 if hour == 12 else hour
    if ampm in ("오후", "pm"):
        return 12 if hour == 12 else hour + 12
    return hour


def dt(y, m, d, ampm, h, mi) -> datetime:
    return datetime(int(y), int(m), int(d), to_24h(ampm, int(h)), int(mi))


def classify(body: str):
    b = body.strip()
    if DELETED_MARKER.match(b):
        return "DELETED", b, None
    if PHOTO_RE.match(b):
        return "PHOTO", b, None
    if b in MEDIA_EXACT:
        return MEDIA_EXACT[b], b, None
    m = FILE_RE.match(b)
    if m:
        return "FILE", b, m.group(2).strip()
    if not b:
        return "EMPTY", "", None
    return "TEXT", b, None


def classify_system(text: str) -> str:
    if SYS_JOIN.match(text) or SYS_JOIN_EN.match(text):
        return "SYSTEM_JOIN"
    if SYS_LEAVE.match(text) or SYS_LEAVE_EN.match(text):
        return "SYSTEM_LEAVE"
    if SYS_INVITE.match(text) or SYS_INVITE_EN.match(text):
        return "SYSTEM_INVITE"
    if SYS_KICK.match(text):
        return "SYSTEM_KICK"
    if DELETED_MARKER.match(text):
        return "DELETED"
    return "SYSTEM_OTHER"


def decode(raw: bytes):
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8"), "UTF-8", False
    if raw.startswith(b"\xff\xfe"):
        return raw[2:].decode("utf-16-le"), "UTF-16LE", False
    if raw.startswith(b"\xfe\xff"):
        return raw[2:].decode("utf-16-be"), "UTF-16BE", False
    try:
        return raw.decode("utf-8"), "UTF-8", False
    except UnicodeDecodeError:
        pass
    try:
        return raw.decode("cp949"), "CP949", True
    except UnicodeDecodeError:
        raise ParseError("ENCODING_UNDETECTED")


def detect_format(lines: list[str]) -> str:
    first = next((l.strip() for l in lines if l.strip()), "")
    if CSV_HEADER_RE.match(first):
        return "KAKAO_CSV"
    counts = {"KAKAO_ANDROID_KO": 0, "KAKAO_IOS_DOTTED": 0, "KAKAO_PC_BRACKET": 0, "KAKAO_EN": 0}
    for line in lines[:1000]:
        if MSG_A.match(line):
            counts["KAKAO_ANDROID_KO"] += 1
        elif MSG_B.match(line):
            counts["KAKAO_IOS_DOTTED"] += 1
        elif MSG_C.match(line):
            counts["KAKAO_PC_BRACKET"] += 1
        elif MSG_E.match(line):
            counts["KAKAO_EN"] += 1
    best = max(counts, key=counts.get)
    if counts[best] == 0:
        raise ParseError("NO_MESSAGES")
    return best


def parse_text(text: str, fmt: str):
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    messages: list[Message] = []
    warnings: dict = {"orphanLines": 0, "unknownSystemLines": 0, "dateUnknownBeforeSeparator": 0}
    title = None
    bare_seps_ok = fmt in ("KAKAO_ANDROID_KO", "KAKAO_IOS_DOTTED", "KAKAO_EN")
    cur_date = None
    cur = None  # [datetime, sender, [lines]]

    def emit(at: datetime, sender, kind, text, file_name=None):
        messages.append(Message(len(messages), at.strftime("%Y-%m-%dT%H:%M"), sender, kind, text, file_name,
                                bool(URL_RE.search(text)), MENTION_RE.findall(text) if kind == "TEXT" else []))

    def flush():
        nonlocal cur
        if cur is None:
            return
        at, sender, body_lines = cur
        body = "\n".join(body_lines).strip()
        kind, text, file_name = classify(body)
        if sender == "오픈채팅봇":
            kind = "BOT"
        emit(at, sender, kind, text, file_name)
        cur = None

    def system(at: datetime, text: str):
        kind = classify_system(text)
        if kind == "SYSTEM_OTHER":
            warnings["unknownSystemLines"] += 1
        emit(at, None, kind, text)

    for raw in lines:
        line = raw[1:] if raw.startswith("﻿") else raw
        s = line.strip()
        # 1) 헤더
        if s and (HEADER_SAVED_AT.match(s) or HEADER_SPLIT_FILE.match(s) or HEADER_TITLE_EN.match(s) or
                  HEADER_TITLE_KO.match(s)):
            flush()
            m = HEADER_TITLE_KO.match(s)
            if m and title is None and not HEADER_SAVED_AT.match(s):
                title = m.group(1)
            m = HEADER_TITLE_EN.match(s)
            if m and title is None:
                title = s[len("KakaoTalk Chats"):].strip() or None
            continue
        # 2) 날짜 구분선
        m = DATE_SEP_DASH.match(s)
        if m:
            flush(); cur_date = (int(m[1]), int(m[2]), int(m[3])); continue
        if bare_seps_ok:
            m = DATE_SEP_BARE.match(s) or (DATE_SEP_DOTTED.match(s) if fmt == "KAKAO_IOS_DOTTED" else None)
            if m:
                flush(); cur_date = (int(m[1]), int(m[2]), int(m[3])); continue
            # 3) 시각만 있는 구분선
            m = TIME_ONLY_KO.match(s) or TIME_ONLY_DOTTED.match(s)
            if m:
                flush(); cur_date = (int(m[1]), int(m[2]), int(m[3])); continue
            m = TIME_ONLY_EN.match(s)
            if m:
                flush(); cur_date = (int(m[3]), MONTH_NUM[m[2]], int(m[1])); continue
        # 4) 메시지 A/B/E
        m = MSG_A.match(line) or MSG_B.match(line)
        if m:
            flush()
            at = dt(m[1], m[2], m[3], m[4], m[5], m[6])
            cur_date = (at.year, at.month, at.day)
            cur = [at, m[7].strip(), [m[8]]]
            continue
        m = MSG_E.match(line)
        if m:
            flush()
            at = dt(m[3], MONTH_NUM[m[2]], m[1], m[6], m[4], m[5])
            cur_date = (at.year, at.month, at.day)
            cur = [at, m[7].strip(), [m[8]]]
            continue
        # 5) 날짜접두 + 콤마, 구분자 없음 → 시스템
        m = SYS_A.match(line) or SYS_B.match(line)
        if m:
            flush(); system(dt(m[1], m[2], m[3], m[4], m[5], m[6]), m[7].strip()); continue
        m = SYS_E.match(line)
        if m:
            flush(); system(dt(m[3], MONTH_NUM[m[2]], m[1], m[6], m[4], m[5]), m[7].strip()); continue
        # 6) 메시지 C
        m = MSG_C.match(line)
        if m:
            flush()
            if cur_date is None:
                warnings["dateUnknownBeforeSeparator"] += 1
                continue
            at = dt(cur_date[0], cur_date[1], cur_date[2], m[2], m[3], m[4])
            cur = [at, m[1].strip(), [m[5]]]
            continue
        # 7) 대괄호/날짜 없는 시스템 줄
        if s and (SYS_JOIN.match(s) or SYS_LEAVE.match(s) or SYS_INVITE.match(s) or SYS_KICK.match(s) or
                  DELETED_MARKER.match(s) or SYS_INVITE_EN.match(s) or SYS_JOIN_EN.match(s) or SYS_LEAVE_EN.match(s)):
            flush()
            last = messages[-1].at if messages else None
            at = datetime.fromisoformat(last) if last else (datetime(*cur_date) if cur_date else datetime(1970, 1, 1))
            system(at, s)
            continue
        # 8) 빈 줄
        if not s:
            if cur is not None:
                cur[2].append("")
            continue
        # 9) 멀티라인 / 고아 줄
        if cur is not None:
            cur[2].append(line)
        else:
            warnings["orphanLines"] += 1
    flush()
    return title, messages, warnings


def parse_csv(text: str):
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    if not rows or not CSV_HEADER_RE.match(",".join(rows[0])):
        raise ParseError("NO_MESSAGES")
    header = [c.strip().lower() for c in rows[0]]
    di, ui, mi = header.index("date"), header.index("user"), header.index("message")
    messages: list[Message] = []
    for row in rows[1:]:
        if len(row) <= max(di, ui, mi):
            continue
        m = CSV_DATE_RE.match(row[di])
        if not m or not row[ui].strip():
            continue
        at = datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]))
        kind, body, fn = classify(row[mi])
        messages.append(Message(len(messages), at.strftime("%Y-%m-%dT%H:%M"), row[ui].strip(), kind, body, fn,
                                bool(URL_RE.search(body)), MENTION_RE.findall(body) if kind == "TEXT" else []))
    return None, messages, {"orphanLines": 0, "unknownSystemLines": 0, "dateUnknownBeforeSeparator": 0}


def dedupe_consecutive(messages: list[Message]) -> tuple[list[Message], int]:
    out: list[Message] = []
    removed = 0
    for m in messages:
        if out and (out[-1].at, out[-1].sender, out[-1].text) == (m.at, m.sender, m.text):
            removed += 1
            continue
        out.append(m)
    for i, m in enumerate(out):
        m.index = i
    return out, removed


def parse_files(paths: list[Path]):
    """분할 파일은 파일별로 개별 파싱한 뒤 메시지 리스트를 연결하고 경계 중복을 제거한다."""
    fallback = False
    title = None
    fmt = None
    messages: list[Message] = []
    warnings = {"orphanLines": 0, "unknownSystemLines": 0, "dateUnknownBeforeSeparator": 0}
    for p in sorted(paths, key=lambda x: x.name):
        text, enc, fb = decode(p.read_bytes())
        fallback = fallback or fb
        lines = text.replace("\r\n", "\n").split("\n")
        f = detect_format(lines)
        fmt = fmt or f
        t, msgs, w = parse_csv(text) if f == "KAKAO_CSV" else parse_text(text, f)
        title = title or t
        messages.extend(msgs)
        for k in warnings:
            warnings[k] += w.get(k, 0)
    messages, removed = dedupe_consecutive(messages)
    non_mono = sum(1 for a, b in zip(messages, messages[1:]) if b.at < a.at)
    warnings.update({"encodingFallback": fallback, "dedupedCount": removed, "nonMonotonicTimestamp": non_mono})
    participants = {}
    for m in messages:
        if m.sender is None or m.kind.startswith("SYSTEM") or m.kind == "BOT":
            continue
        p = participants.setdefault(m.sender, {"rawName": m.sender, "messageCount": 0, "firstAt": m.at, "lastAt": m.at})
        p["messageCount"] += 1
        p["lastAt"] = m.at
    if not messages:
        raise ParseError("NO_MESSAGES")
    return {"title": title, "sourceFormat": fmt, "messageCount": len(messages),
            "participants": list(participants.values()), "warnings": warnings,
            "messages": [asdict(m) for m in messages]}


def main():
    fixtures = Path(sys.argv[1])
    write = "--write-expected" in sys.argv
    groups: dict[str, list[Path]] = {}
    for p in sorted(fixtures.iterdir()):
        if p.is_dir():
            groups[p.name] = sorted(x for x in p.iterdir() if x.suffix in (".txt", ".csv"))
        elif p.suffix in (".txt", ".csv"):
            groups[p.stem] = [p]
    for name, paths in groups.items():
        print(f"\n=== {name} ({len(paths)} file(s))")
        try:
            result = parse_files(paths)
        except ParseError as e:
            print(f"  ERROR {e.code}")
            if write:
                (fixtures / f"{name}.expected.json").write_text(json.dumps({"error": e.code}, ensure_ascii=False, indent=1))
            continue
        kinds: dict[str, int] = {}
        for m in result["messages"]:
            kinds[m["kind"]] = kinds.get(m["kind"], 0) + 1
        print(f"  format={result['sourceFormat']} title={result['title']!r} messages={result['messageCount']} kinds={kinds}")
        print(f"  participants={[(p['rawName'], p['messageCount']) for p in result['participants']]}")
        print(f"  warnings={result['warnings']}")
        for m in result["messages"][:6]:
            print(f"   m{m['index']} {m['at']} {m['sender']!r} {m['kind']} {m['text'][:40]!r}")
        if write:
            (fixtures / f"{name}.expected.json").write_text(json.dumps(result, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
