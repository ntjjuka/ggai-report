// 카카오톡 내보내기 파서의 정규화 모델 (docs/03 §4)

export type SourceFormat =
  | "KAKAO_ANDROID_KO"
  | "KAKAO_IOS_DOTTED"
  | "KAKAO_PC_BRACKET"
  | "KAKAO_CSV"
  | "KAKAO_EN";

export type MessageKind =
  | "TEXT"
  | "PHOTO"
  | "VIDEO"
  | "EMOTICON"
  | "VOICE"
  | "FILE"
  /** 헥스 덤프·해시·base64·로그처럼 사람 말이 아닌 본문 (patterns.isBlobLike). 첨부처럼 개수만 센다 */
  | "DATA"
  | "MAP"
  | "CONTACT"
  | "DELETED"
  | "EMPTY"
  | "SYSTEM_JOIN"
  | "SYSTEM_LEAVE"
  | "SYSTEM_INVITE"
  | "SYSTEM_KICK"
  | "SYSTEM_OTHER"
  | "BOT";

export const SYSTEM_KINDS: ReadonlySet<MessageKind> = new Set([
  "SYSTEM_JOIN",
  "SYSTEM_LEAVE",
  "SYSTEM_INVITE",
  "SYSTEM_KICK",
  "SYSTEM_OTHER",
]);

export const MEDIA_KINDS: ReadonlySet<MessageKind> = new Set([
  "PHOTO",
  "VIDEO",
  "EMOTICON",
  "VOICE",
  "FILE",
  "DATA",
  "MAP",
  "CONTACT",
]);

/** 대화 메시지. `at`은 기기 로컬 시각(TZ 없음) `yyyy-MM-ddTHH:mm`. index는 결정적(같은 입력 → 같은 index). */
export interface Message {
  index: number;
  at: string;
  sender: string | null;
  kind: MessageKind;
  text: string;
  fileName: string | null;
  hasLink: boolean;
  mentions: string[];
}

export interface ParticipantSummary {
  rawName: string;
  messageCount: number;
  firstAt: string;
  lastAt: string;
}

export interface ParseWarnings {
  orphanLines: number;
  unknownSystemLines: number;
  dateUnknownBeforeSeparator: number;
  encodingFallback: boolean;
  dedupedCount: number;
  nonMonotonicTimestamp: number;
}

export interface ParsedChat {
  title: string | null;
  sourceFormat: SourceFormat;
  messageCount: number;
  participants: ParticipantSummary[];
  warnings: ParseWarnings;
  messages: Message[];
}

export interface NamedText {
  name: string;
  text: string;
}

export interface NamedBytes {
  name: string;
  bytes: Uint8Array;
}

export type ParseErrorCode =
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_TOO_LARGE"
  | "ENCODING_UNDETECTED"
  | "NO_MESSAGES"
  | "TOO_FEW_MESSAGES"
  | "TOO_MANY_MESSAGES"
  | "TOO_MANY_PARTICIPANTS"
  | "ZIP_TOO_MANY_ENTRIES"
  | "ZIP_TOO_LARGE"
  | "ZIP_UNSAFE_ENTRY"
  | "ZIP_BOMB_SUSPECTED"
  | "ZIP_INVALID";

export class ParseError extends Error {
  constructor(
    public readonly code: ParseErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ParseError";
  }
}

export interface ParseLimits {
  maxMessages: number;
  minMessages: number;
  maxParticipants: number;
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxMessages: 300_000,
  minMessages: 30,
  maxParticipants: 60,
};

/** 사용자 노출 메시지 (docs/03 §6) */
export const PARSE_ERROR_MESSAGES: Record<ParseErrorCode, string> = {
  UNSUPPORTED_FILE_TYPE: "txt, csv, zip 파일만 올릴 수 있어요",
  FILE_TOO_LARGE: "파일이 너무 커요 (최대 50MB)",
  ENCODING_UNDETECTED: "파일 인코딩을 읽을 수 없어요. 카카오톡에서 다시 내보내 주세요",
  NO_MESSAGES: "대화 메시지를 찾지 못했어요. 카카오톡 \"대화 내보내기\" 파일인지 확인해 주세요",
  TOO_FEW_MESSAGES: "메시지가 30개 미만이라 분석할 수 없어요",
  TOO_MANY_MESSAGES: "메시지가 너무 많아요 (최대 30만 개)",
  TOO_MANY_PARTICIPANTS: "참여자가 너무 많아요 (최대 60명)",
  ZIP_TOO_MANY_ENTRIES: "압축 파일을 처리할 수 없어요 (파일 수 초과)",
  ZIP_TOO_LARGE: "압축 파일을 처리할 수 없어요 (용량 초과)",
  ZIP_UNSAFE_ENTRY: "압축 파일을 처리할 수 없어요 (허용되지 않는 경로)",
  ZIP_BOMB_SUSPECTED: "압축 파일을 처리할 수 없어요 (비정상 압축률)",
  ZIP_INVALID: "압축 파일을 열 수 없어요",
};
