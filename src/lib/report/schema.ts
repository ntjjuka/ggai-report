// docs/07 §3·§4 — LLM 출력 스키마(zod, 구조화 출력용으로 단순하게)와 최종 ReportContent
import { z } from "zod";

export const FOCUS = ["AUTO", "ROMANCE", "FRIENDS_GROUP", "FRIEND_ONE", "FAMILY", "WORK", "OTHER"] as const;
export const FOCUS_LABEL: Record<(typeof FOCUS)[number], string> = { AUTO: "자동", ROMANCE: "연애", FRIENDS_GROUP: "친구 단톡방", FRIEND_ONE: "친구 한 명", FAMILY: "가족", WORK: "회사/팀", OTHER: "기타" };
export type Focus = (typeof FOCUS)[number];
export const MOOD = ["DIRECT", "WARM", "DRY", "HYPED"] as const;
export type Mood = (typeof MOOD)[number];
export const MOOD_LABEL: Record<Mood, string> = { DIRECT: "직진", WARM: "다정", DRY: "건조", HYPED: "들뜸" };
export const CONFIDENCE = ["HIGH", "MEDIUM", "LOW"] as const;
export type Confidence = (typeof CONFIDENCE)[number];
export const CONFIDENCE_LABEL: Record<Confidence, string> = { HIGH: "확실해", MEDIUM: "아마도", LOW: "감이야" };
export const MOMENT_KINDS = ["funny", "flutter", "touching", "banter", "awkward", "clash"] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];
export const SAFETY_FLAGS = ["SELF_HARM", "VIOLENCE", "ABUSE", "STALKING", "MINOR"] as const;

const Conf = z.enum(CONFIDENCE);
const Ids = z.array(z.string()).describe("근거 메시지 ID 목록 (m123 형식). 텍스트 인용 금지");

// ── 청크 추출 (docs/07 §4.1) ───────────────────────────────────────────
export const ChunkExtractionSchema = z.object({
  summary: z.string().describe("이 구간의 흐름 2~3문장"),
  events: z.array(z.object({ date: z.string().describe("YYYY-MM-DD"), title: z.string(), summary: z.string(), evidenceIds: Ids })),
  signals: z.array(
    z.object({
      participantId: z.string(),
      interest: z.number().describe("상대/방에 대한 관심 0~100"),
      effort: z.number().describe("노력 0~100"),
      toneLabel: z.string(),
      reason: z.string(),
      topics: z.array(z.string()).describe("이 구간에서 이 사람이 주로 떠든 주제 1~3개, 구체 명사(상품·장소·사람·취미·불평거리)"),
      details: z.array(z.string()).describe("본인이 직접 말한 구체 디테일 1~3개(소비·습관·사건·자랑·변명·말 vs 행동), 각 40자 이내, 끝에 메시지 ID 1개"),
      evidenceIds: Ids.describe("이 사람 메시지 중 캐릭터가 가장 드러나는 것 1~2개 (m123 형식)"),
    }),
  ),
  highlights: z.array(z.object({ messageId: z.string(), kind: z.enum(MOMENT_KINDS), caption: z.string().describe("60자 이내") })),
  keywords: z.array(z.string()).describe("8개 이내"),
  roastMaterial: z.array(z.object({ participantId: z.string(), observation: z.string().describe("반복되는 행동 패턴"), evidenceIds: Ids, device: z.string().describe("유머 장치 id 제안") })),
  conflicts: z.array(z.object({ startMessageId: z.string(), endMessageId: z.string(), summary: z.string(), repaired: z.boolean(), repairedBy: z.string().nullable() })),
  plans: z.array(z.object({ proposedMessageId: z.string(), what: z.string(), followedThrough: z.enum(["YES", "NO", "UNKNOWN"]), evidenceIds: Ids })),
  safetyFlags: z.array(z.string()).describe("SELF_HARM|VIOLENCE|ABUSE|STALKING|MINOR 중 해당하는 것, 없으면 빈 배열"),
});
export type ChunkExtraction = z.infer<typeof ChunkExtractionSchema>;

// ── 종합 초안 (docs/07 §4.2) ─────────────────────────────────────────
// 키 순서 = 작성 순서: ① 재밌게 읽은 장면(moments) ② 인물 페르소나(participants) ③ 판정(verdict) … (책 한 권을 다 읽고 → 인상적인 장면 → 사람별 정리 → 명쾌한 결론)
export const ReportDraftSchema = z.object({
  moments: z
    .array(
      z.object({
        kind: z.enum(MOMENT_KINDS),
        title: z.string().describe("장면 제목 조어 ≤30자"),
        summary: z.string().describe("그 장면이 왜 재밌었는지 2~3문장 서술(로스트 화법, 등장인물의 말 그대로 되돌려주기)"),
        participantIds: z.array(z.string()).describe("등장인물 participantId 1~4"),
        messageIds: Ids.describe("그 장면의 실제 메시지 1~3개"),
      }),
    )
    .describe("전체를 다 읽고 가장 재밌게 읽은 장면 5~7개 — 책 한 권을 읽고 인상적인 에피소드를 고르듯. 이 장면들이 인물 페르소나의 재료다"),
  participants: z.array(
    z.object({
      participantId: z.string(),
      emoji: z.string().describe("이 사람 캐릭터를 요약하는 이모지 1개"),
      title: z.string().describe("칭호 20~45자: 「수식절 + '별명'」 꼴. 예: 회식 자리마다 다음 회식을 예약하는 '2차 사장'"),
      nickname: z.string().describe("title 속 따옴표 별명만"),
      type: z.object({
        label: z.string().describe("이 방에서 이 사람의 유형 라벨 4~12자(…형/…파/…족), 예: 프로 불참러형"),
        description: z.string().describe("그 유형이 이 대화에서 어떻게 드러나는지 한 문장"),
      }),
      topics: z.array(z.string()).describe("이 사람이 주로 떠든 주제 2~4개, 구체 명사(상품·장소·취미·불평거리·자랑거리). '일상'처럼 뭉개지 않는다"),
      paragraphs: z.array(
        z.object({
          text: z.string().describe("로스트 문단 150~450자: 재밌게 읽은 장면 속 본인의 말·행동 디테일 2~3개를 쌓고 마지막 절에서 꺾는다"),
          quoteIds: Ids.describe("이 문단을 뒷받침하는 그 사람 메시지 0~2개. 서버가 문단 아래 말풍선으로 붙인다"),
        }),
      ).describe("2~3문단(참여자 9명 이상이면 텍스트 지분 상위 8명만 2~3문단, 나머지 1문단)"),
      oneLiner: z.string().describe("이 사람을 끝내는 명쾌한 한 줄 결론 15~40자, '결론:'으로 시작"),
      badgeIds: z.array(z.string()).describe("뱃지 id 0~2개"),
    }),
  ),
  verdict: z.object({
    reportTitle: z.string().describe("보고서 제목 조어 20~40자: 「○○ 보고서: 부제」 꼴. 이 방에서만 나올 수 있는 명사로"),
    headline: z.string().describe("40자 이내, 이모지 0, 숫자 1개 이하. 스크린샷용 한 문장 판정"),
    body: z.array(z.string()).describe("3~4문단: 결론+숫자 / '그런데 m####를 봐' 반전 / 진짜였던 것·바뀐 것 / 애정 한 줄"),
    relationType: z.object({ code: z.string().describe("영문 4~8자"), label: z.string().describe("한국어 라벨"), description: z.string() }),
    confidence: Conf,
  }),
  dynamic: z.object({
    paragraphs: z.array(z.string()).describe("2~3문단 선언문"),
    groupRoles: z.object({
      holdsTogether: z.string().nullable().describe("판을 들고 있는 사람 participantId (단톡만)"),
      goesQuiet: z.string().nullable().describe("사라지는 사람 participantId"),
      runsTheShow: z.string().nullable().describe("판을 쥔 사람 participantId"),
    }),
    evidenceIds: Ids,
  }),
  firstMove: z.object({
    initiatorId: z.string().nullable().describe("먼저 치는 사람 participantId"),
    pretenderId: z.string().nullable().describe("아닌 척하는 사람 participantId (없으면 null)"),
    body: z.string().describe("누가 먼저 치고 누가 아닌 척하는지 2~3문장. 숫자 1개 + 근거 ID"),
    evidenceIds: Ids,
  }),
  privateLanguage: z.object({
    phrases: z.array(z.object({ phrase: z.string(), meaning: z.string().describe("이 대화에서 그 표현이 뜻하는 것"), evidenceIds: Ids })).describe("둘(방)만의 언어·말버릇 0~5개, 실제 반복된 것만"),
    runningJokes: z.array(z.object({ title: z.string(), summary: z.string(), evidenceIds: Ids })).describe("반복되는 농담 0~4개"),
  }),
  weekChanged: z.object({
    exists: z.boolean().describe("뚜렷한 변화가 있으면 true"),
    weekLabel: z.string().describe("예: 2025년 6월 둘째 주"),
    weekStart: z.string().describe("그 주 월요일 YYYY-MM-DD"),
    before: z.string(),
    after: z.string(),
    pivotMessageId: z.string().nullable().describe("결정적 한 줄 메시지 ID"),
    evidenceIds: Ids,
    confidence: Conf,
  }),
  findings: z.array(
    z.object({
      title: z.string(),
      observed: z.string().describe("보인 것 1문장"),
      interpretation: z.string().describe("내 해석 1~2문장"),
      evidenceIds: Ids,
      confidence: Conf,
      tags: z.array(z.string()),
    }),
  ),
  whatIWouldDo: z.array(z.object({ title: z.string(), body: z.string().describe("'내가 너라면 …'으로 시작, 2문장"), deadline: z.string().describe("예: 이번 주") })),
  awards: z.array(z.object({ name: z.string().describe("행동 기반 상 이름, 예: 읽씹 장인상"), participantId: z.string().nullable(), reason: z.string(), evidenceIds: Ids })),
  scores: z.array(z.object({ key: z.string(), value: z.number().describe("0~100"), oneLiner: z.string().describe("숫자나 ID 1개 이상 포함"), confidence: Conf })),
  visualCaptions: z.object({ monthly: z.string(), heatmap: z.string(), reply: z.string(), initiation: z.string() }),
  answer: z.object({ body: z.string(), confidence: Conf, evidenceIds: Ids }).nullable(),
  shareCard: z.object({ headline: z.string(), subline: z.string().describe("30자 이내") }),
  safetyFlags: z.array(z.string()),
});
export type ReportDraft = z.infer<typeof ReportDraftSchema>;

// 수리: 위반 경로별 교체 값(JSON 문자열)
export const RepairResponseSchema = z.object({
  patches: z.array(z.object({ path: z.string().describe("예: findings[2], verdict.headline"), valueJson: z.string().describe("교체 값의 JSON 문자열") })),
});
export type RepairResponse = z.infer<typeof RepairResponseSchema>;

// ── 최종 콘텐츠 (서버 조립) ───────────────────────────────────────────
export interface Evidence {
  messageId: string;
  participantId: string;
  participantName: string;
  at: string;
  text: string;
}

export interface ReportContent {
  schemaVersion: 1;
  persona: { name: string };
  mood: Mood;
  meta: {
    title: string;
    focus: Focus;
    resolvedFocus: Exclude<Focus, "AUTO">;
    period: { from: string; to: string; days: number };
    messageCount: number;
    participants: { id: string; name: string; isUploader: boolean }[];
    coveragePct: number;
    generatedAt: string;
  };
  verdict: ReportDraft["verdict"];
  dynamic: { paragraphs: string[]; groupRoles: ReportDraft["dynamic"]["groupRoles"]; evidence: Evidence[] };
  firstMove: { initiator: { id: string; name: string } | null; pretender: { id: string; name: string } | null; body: string; evidence: Evidence[] };
  privateLanguage: { phrases: { phrase: string; meaning: string; evidence: Evidence[] }[]; runningJokes: { title: string; summary: string; evidence: Evidence[] }[] };
  weekChanged: Omit<ReportDraft["weekChanged"], "pivotMessageId" | "evidenceIds"> & { pivot: Evidence | null; evidence: Evidence[] };
  /** 인물 페르소나 — 보고서의 메인 코너. 문단마다 그 사람의 실제 메시지(quotes)를 말풍선으로 붙인다 */
  participants: {
    participantId: string;
    name: string;
    isUploader: boolean;
    emoji: string;
    title: string;
    nickname: string;
    type: { label: string; description: string };
    topics: string[];
    paragraphs: { text: string; quotes: Evidence[] }[];
    /** 명쾌한 한 줄 결론 ("결론: …"). 구버전 보고서에는 없다 */
    oneLiner?: string;
    badges: { id: string; name: string; icon: string }[];
    awardNames: string[];
  }[];
  findings: (Omit<ReportDraft["findings"][number], "evidenceIds"> & { id: number; evidence: Evidence[] })[];
  whatIWouldDo: ReportDraft["whatIWouldDo"];
  awards: (Omit<ReportDraft["awards"][number], "evidenceIds"> & { participantName: string | null; evidence: Evidence[] })[];
  scores: (ReportDraft["scores"][number] & { label: string; prior: number | null })[];
  /** 까비서가 재밌게 읽은 장면(판정 직후). 구버전 보고서는 caption만 있다 */
  moments: { kind: MomentKind; title: string; summary: string; caption?: string; participants: { id: string; name: string }[]; messages: Evidence[] }[];
  visuals: {
    monthly: { month: string; total: number; perPerson: Record<string, number> }[];
    heatmap: number[][];
    replyLatency: Record<string, { medianSec: number | null; p90Sec: number | null }>;
    initiationShare: Record<string, number>;
    media: { photo: number; video: number; emoticon: number; voice: number; file: number };
    captions: ReportDraft["visualCaptions"];
  };
  answer: (Omit<NonNullable<ReportDraft["answer"]>, "evidenceIds"> & { question: string; evidence: Evidence[] }) | null;
  /** 산문 속 m123 참조 → 실제 메시지 (UI가 칩으로 렌더). 구버전 보고서에는 없을 수 있다 */
  inlineEvidence?: Record<string, Evidence>;
  shareCard: ReportDraft["shareCard"] & { emoji: string };
  signature: string;
  safety: { flags: string[]; notice: string | null };
  disclaimer: string;
  quality: {
    mode: "SINGLE" | "CHUNKED";
    chunks: { total: number; succeeded: number };
    evidence: { total: number; dropped: number };
    lowFindings: number;
    repaired: boolean;
    unverifiedNumbers: number;
    models: { chunk: string | null; synthesis: string };
    tokens: { input: number; output: number; cacheRead: number };
    costUsd: number;
    durationSec: number;
  };
}

export const DISCLAIMER = "까비서의 보고서는 대화에서 관찰된 패턴에 대한 해석이에요. 마음을 읽는 것도, 진단이나 전문 조언도 아니에요.";
