// docs/03 §2 정규식 카탈로그. 프로토타입(docs/tools/spec_parser_prototype.py)과 1:1 대응.

export const MONTHS_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const MONTHS_RE = MONTHS_EN.join("|");
export const MONTH_NUM: Record<string, number> = Object.fromEntries(
  MONTHS_EN.map((m, i) => [m, i + 1]),
);

// ── 헤더 ─────────────────────────────────────────────────────────────
export const HEADER_TITLE_KO = /^(.+?)\s*(님과|와|과)?\s*카카오톡 대화\s*$/;
export const HEADER_TITLE_EN = /^KakaoTalk Chats\b.*$/;
export const HEADER_SAVED_AT = /^(저장한 날짜|Date Saved)\s*:\s*(.+)$/;
export const HEADER_SPLIT_FILE = /^(Talk_.+\.txt|KakaoTalkChats.*\.txt)$/;

// ── 날짜 구분선 ──────────────────────────────────────────────────────
export const DATE_SEP_DASH =
  /^-{3,}\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s+[일월화수목금토]요일)?\s*-{3,}\s*$/;
export const DATE_SEP_BARE = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s+[일월화수목금토]요일\s*$/;
export const DATE_SEP_DOTTED =
  /^(?:-{3,}\s*)?(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?(?:\s+[일월화수목금토]요일)?(?:\s*-{3,})?\s*$/;
export const TIME_ONLY_KO = /^(\d{4})년 (\d{1,2})월 (\d{1,2})일 (오전|오후) (\d{1,2}):(\d{2})$/;
export const TIME_ONLY_DOTTED = /^(\d{4})\. (\d{1,2})\. (\d{1,2})\. (?:(오전|오후) )?(\d{1,2}):(\d{2})$/;
export const TIME_ONLY_EN = new RegExp(
  `^(\\d{1,2}) (${MONTHS_RE}) (\\d{4}) at (\\d{1,2}):(\\d{2}) (am|pm)$`,
);

// ── 메시지 ───────────────────────────────────────────────────────────
// 공통 꼬리: ", 발신자 : 본문" — 첫 " : "만 구분자. 본문이 비면 " :"로 끝날 수 있음.
const SEP = ",\\s(.+?)\\s:(?:\\s|$)([\\s\\S]*)$";
export const MSG_A = new RegExp(
  "^(\\d{4})년\\s*(\\d{1,2})월\\s*(\\d{1,2})일\\s+(?:(오전|오후)\\s*)?(\\d{1,2}):(\\d{2})" + SEP,
);
export const MSG_B = new RegExp(
  "^(\\d{4})\\.\\s(\\d{1,2})\\.\\s(\\d{1,2})\\.\\s(?:(오전|오후)\\s)?(\\d{1,2}):(\\d{2})" + SEP,
);
export const MSG_C = /^\[(.+?)\]\s\[(?:(오전|오후)\s?)?(\d{1,2}):(\d{2})\]\s?(.*)$/;
export const MSG_E = new RegExp(
  `^(\\d{1,2})\\s(${MONTHS_RE})\\s(\\d{4})\\sat\\s(\\d{1,2}):(\\d{2})\\s(am|pm)` + SEP,
);

// 날짜접두 + ", " 있고 " : " 없음 → 시스템 줄
export const SYS_A =
  /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s+(?:(오전|오후)\s*)?(\d{1,2}):(\d{2}),\s(.+)$/;
export const SYS_B = /^(\d{4})\.\s(\d{1,2})\.\s(\d{1,2})\.\s(?:(오전|오후)\s)?(\d{1,2}):(\d{2}),\s(.+)$/;
export const SYS_E = new RegExp(
  `^(\\d{1,2})\\s(${MONTHS_RE})\\s(\\d{4})\\sat\\s(\\d{1,2}):(\\d{2})\\s(am|pm),\\s(.+)$`,
);

// ── 시스템 분류 ──────────────────────────────────────────────────────
export const SYS_JOIN = /^(.{1,60}?)님이 들어왔습니다\.?$/;
export const SYS_LEAVE = /^(.{1,60}?)님이 (채팅방을 )?나갔습니다\.?$/;
export const SYS_INVITE = /^(.{1,60}?)님이 (.+?)님을 초대했습니다\.?$/;
export const SYS_KICK = /^(.{1,60}?)님을 내보냈습니다\.?$/;
export const SYS_INVITE_EN = /^(.+?) invited (.+)\.$/;
export const SYS_JOIN_EN = /^(.+?) joined( this chatroom)?\.$/;
export const SYS_LEAVE_EN = /^(.+?) left( this chatroom)?\.$/;
export const DELETED_MARKER =
  /^(메시지가 삭제되었습니다\.|삭제된 메시지입니다\.|The message has been deleted\.)$/;

// ── 미디어 ───────────────────────────────────────────────────────────
export const PHOTO_RE = /^(사진( \d{1,2}장)?|<사진 읽지 않음>|Photo)$/;
export const FILE_RE = /^(파일|File):\s*(.+)$/;
export const MEDIA_EXACT: Record<string, "VIDEO" | "EMOTICON" | "VOICE" | "MAP" | "CONTACT"> = {
  동영상: "VIDEO",
  "<동영상 읽지 않음>": "VIDEO",
  Video: "VIDEO",
  이모티콘: "EMOTICON",
  "(이모티콘)": "EMOTICON",
  Emoticon: "EMOTICON",
  음성메시지: "VOICE",
  "Voice message": "VOICE",
  지도: "MAP",
  연락처: "CONTACT",
};

export const URL_RE = /https?:\/\/\S+/;
export const MENTION_RE = /@(\S{1,20})/g;
export const CSV_HEADER_RE = /^"?date"?\s*,\s*"?user"?\s*,\s*"?message"?$/i;
export const CSV_DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?/;

export const BOT_SENDER = "오픈채팅봇";
/** 카카오톡 시스템 봇 발신자 이름 (docs/03 §2.4, docs/18 P1-2). 사람이 쓸 법한 별명은 넣지 않는다. */
export const BOT_SENDERS: ReadonlySet<string> = new Set(["오픈채팅봇", "오픈채팅 봇", "채팅봇", "플레이봇", "카카오톡 채팅봇"]);
const BOT_SENDER_RE = /^(?:카카오톡\s?)?(?:오픈)?(?:채팅|플레이)\s?봇$/;
export function isBotSender(name: string): boolean {
  const n = name.trim();
  return BOT_SENDERS.has(n) || BOT_SENDER_RE.test(n);
}

// ── 데이터 덩어리(헥스 덤프·해시·base64·로그) 판정 ─────────────────────────
// 실측(2026-11-03): 파일·이미지가 헥스 문자열로 들어온 메시지가 "가장 긴 메시지"·장문파·평균 길이를 독식했다.
// 이런 본문은 대화가 아니므로 kind "DATA"로 분류해 텍스트 통계·전사에서 뺀다(첨부처럼 개수만 센다).
const HEX_RUN = /[0-9a-fA-F]{32,}/;
const LONG_OPAQUE_TOKEN = /(?:^|\s)[A-Za-z0-9+/=_-]{60,}(?=\s|$)/;

export function isBlobLike(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;
  const nonSpace = t.replace(/\s+/g, "");
  if (nonSpace.length === 0) return false;
  const hangul = (nonSpace.match(/[가-힣]/g) ?? []).length;
  if (HEX_RUN.test(t)) {
    const hex = (nonSpace.match(/[0-9a-fA-F]/g) ?? []).length;
    if (hex / nonSpace.length >= 0.6) return true; // 헥스 덤프·해시 나열
  }
  if (hangul === 0 && LONG_OPAQUE_TOKEN.test(t) && !/https?:\/\//.test(t)) return true; // base64·토큰 덩어리 (URL은 제외)
  const letters = hangul + (nonSpace.match(/[A-Za-z]/g) ?? []).length;
  if (nonSpace.length >= 120 && letters / nonSpace.length < 0.4) return true; // 숫자·기호가 대부분인 긴 본문(로그·좌표·표)
  return false;
}
