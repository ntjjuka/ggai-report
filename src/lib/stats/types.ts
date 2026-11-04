// docs/08 §3 ChatStats — 결정적 통계. 메시지 본문은 담지 않고 index만 참조한다.

export interface EffectiveParticipant {
  id: string; // 보고서 내 참여자 ID (p1, p2 …) 또는 DB UUID
  name: string; // 표시 이름
  rawNames: string[]; // 병합된 원본 이름들
  isUploader: boolean;
}

/** rawName → 유효 참여자. excluded 는 undefined(매핑 없음)로 표현 */
export type ParticipantMap = Map<string, EffectiveParticipant>;

export interface PersonStat {
  id: string;
  name: string;
  messages: number; // 텍스트+미디어+삭제 (시스템 제외)
  textMessages: number;
  chars: number;
  avgLen: number;
  share: number; // 0..1
  initiations: number; // 세션 시작 수
  replyCount: number;
  replyMedianSec: number | null;
  replyP90Sec: number | null;
  emoticons: number;
  photos: number;
  laughs: number; // ㅋ/ㅎ 문자 수
  questions: number;
  exclaims: number;
  lateNight: number; // 0~5시
  links: number;
  mentionsMade: number;
  longestMessageIndex: number | null;
  longestMessageLen: number;
  sessionEnds: number; // 세션 마지막 발화 수
  /** 이 사람이 방 전체보다 유난히 많이 쓴 단어(관심사 힌트): count=본인, total=방 전체 */
  focusWords: { word: string; count: number; total: number }[];
  longestSilentDays: number; // 본인 최장 무발화 기간(일)
  fastReplyRate: number | null; // 칼답률: 답장 중 60초 이내 비율 (0..1)
  vocative: { term: string; count: number } | null; // 서로를 부르는 말 (가장 자주 쓴 호칭)
}

export interface MonthlyVolume {
  month: string; // YYYY-MM
  total: number;
  perPerson: Record<string, number>;
}

export interface FunFacts {
  goldenHour: { weekday: number; hour: number; count: number } | null; // weekday 0=일
  busiestDay: { date: string; count: number } | null;
  longestSilence: { hours: number; brokenById: string; brokenAt: string; messageIndex: number; precededByIndex: number } | null;
  firstMessageIndex: number | null;
  topEmoji: Record<string, string | null>;
  nightOwl: { id: string; count: number } | null;
  mostLaughs: { id: string; perMessage: number } | null;
  ghost: { id: string; days: number } | null; // 최장 무발화(단톡 유령)
  mostPhotos: { id: string; count: number } | null;
  linkCurator: { id: string; count: number } | null;
  firstDay: { date: string; indices: number[] } | null; // 모든 건 여기서 시작
  lastDay: { date: string; indices: number[] } | null; // 그리고 지금, 여기까지
  longestMessages: { id: string; index: number; len: number; date: string }[]; // 사람별 최장 메시지 상위 3
  longestActiveStreakDays: number; // 최장 연속 대화(일)
  laughRanking: { id: string; count: number }[]; // 웃음 지문 (ㅋ 개수)
  longestLaughRun: { id: string; len: number; index: number } | null; // 최고 기록 ㅋ N연타
  topWords: { word: string; count: number }[]; // 가장 많이 쓴 단어 5
  verbalTics: { word: string; count: number; ratio: number }[]; // 말버릇 (일반 채팅 대비 배수)
  topEmojis: { emoji: string; count: number }[]; // 가장 많이 쓴 이모지 5
  emoticonShare: Record<string, number>; // 사람별 이모티콘 비율
}

export interface Balance {
  /** 기준 참여자: 업로더, 미지정 시 첫 참여자 */
  uploaderId: string;
  otherId: string;
  messageRatio: number; // 업로더 비율 0..1
  initiationRatio: number; // 업로더 선톡 비율 0..1
  replySpeedRatio: number | null; // 업로더 중앙값 / (업로더+상대) — 0.5 균형, 낮을수록 업로더가 빠름
  questionRatio: number; // 업로더 질문 비율
  lean: number; // -1..1 양수면 업로더가 더 기울어짐(선톡·질문·메시지 종합)
}

export interface ChatStats {
  statsVersion: 1;
  total: {
    messages: number;
    textMessages: number;
    media: { photo: number; video: number; emoticon: number; voice: number; file: number; other: number };
    deleted: number;
    links: number;
    systemEvents: number;
  };
  period: { startedAt: string; endedAt: string; days: number; activeDays: number };
  perPerson: PersonStat[];
  sessions: { count: number; avgLenMsgs: number; gapHours: number; starts: Record<string, number>; ends: Record<string, number> };
  rhythm: { heatmap: number[][]; hourly: number[]; nightShare: number; peakHour: number; monthly: MonthlyVolume[]; weekly: { week: string; total: number }[] };
  turnTaking: { avgConsecutive: Record<string, number> };
  funFacts: FunFacts;
  balance: Balance | null;
}

export const SESSION_GAP_HOURS = 6;
