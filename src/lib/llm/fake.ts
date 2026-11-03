// 결정적 가짜 LLM — 테스트·LLM 없는 로컬 실행용 (LLM_PROVIDER=fake)
import type { ChunkExtraction, ReportDraft, RepairResponse } from "@/lib/report/schema";
import { LlmError, type LlmClient, type StageRequest, type StageResponse } from "./client";

export type FakeScenario = "ok" | "hallucinate_ids" | "hanja" | "forbidden" | "refusal" | "rate_limit" | "missing_participant";

export class FakeLlmClient implements LlmClient {
  readonly provider = "fake" as const;
  calls: { stage: string; model: string; requestKey: string }[] = [];
  constructor(private readonly scenario: FakeScenario = "ok") {}

  async countTokens(_model: string, system: string, user: string): Promise<number> {
    return Math.ceil((system.length + user.length) / 1.6);
  }

  async generateJson<T>(req: StageRequest<T>): Promise<StageResponse<T>> {
    this.calls.push({ stage: req.stage, model: req.model, requestKey: req.requestKey });
    if (this.scenario === "rate_limit") throw new LlmError("LLM_UNAVAILABLE", "fake 429", true);
    if (this.scenario === "refusal") throw new LlmError("LLM_REFUSED", "fake refusal", false);
    const h = req.hints ?? { messageIds: [], participantIds: [], speakerOf: {}, uploaderId: null, numbers: [], scoreKeys: [], priors: {} };
    const ids = h.messageIds;
    const idAt = (i: number) => ids[Math.min(ids.length - 1, Math.max(0, Math.floor((i * 7919) % Math.max(1, ids.length))))] ?? "m0";
    const bogus = this.scenario === "hallucinate_ids" ? ["m999999"] : [];
    const hanja = this.scenario === "hanja" ? " 推荐" : "";
    const forbidden = this.scenario === "forbidden" ? " 뚱뚱해서 그래" : "";
    const value =
      req.stage === "CHUNK" ? this.chunk(h, idAt, bogus) : req.stage === "SYNTHESIS" ? this.synthesis(h, idAt, bogus, hanja, forbidden, /\[업로더의 질문\] 「/.test(req.user)) : this.repair(req.user, idAt);
    const inputTokens = Math.ceil((req.system.length + req.user.length) / 1.6);
    return {
      value: value as unknown as T,
      usage: { input: inputTokens, output: 1200, cacheRead: Math.floor(req.system.length / 1.6), cacheWrite: 0 },
      model: req.model,
      latencyMs: 5,
      attempts: 1,
    };
  }

  private chunk(h: NonNullable<StageRequest<unknown>["hints"]>, idAt: (i: number) => string, bogus: string[]): ChunkExtraction {
    const ps = h.participantIds;
    const ownOf = (p: string) => h.messageIds.filter((id) => h.speakerOf[id] === p);
    return {
      summary: "이 구간은 한쪽이 묻고 한쪽이 답하는 구조다. 계획은 나왔고 날짜는 안 나왔다.",
      events: [{ date: "2025-01-01", title: "계획이 처음 나온 날", summary: "누군가 '보자'고 했고 아무도 날짜를 안 박았다.", evidenceIds: [idAt(1), ...bogus] }],
      signals: ps.map((p, i) => {
        const own = ownOf(p);
        return {
          participantId: p,
          interest: 70 - i * 20,
          effort: 65 - i * 25,
          toneLabel: i === 0 ? "적극" : "건조",
          reason: "선톡과 질문 빈도",
          topics: i === 0 ? ["주말 약속", "카페"] : ["ㅇㅇ", "나중에"],
          details: own.length ? [`'보자'를 먼저 꺼내고 날짜는 안 냄(${own[0]})`] : [],
          evidenceIds: own.length ? [own[0]] : [idAt(2 + i)],
        };
      }),
      highlights: [
        { messageId: idAt(3), kind: "funny", caption: "여기서 둘 다 웃었다" },
        { messageId: idAt(5), kind: "awkward", caption: "답이 하루 늦게 왔다" },
      ],
      keywords: ["약속", "주말", "카페"],
      roastMaterial: ps.slice(0, 2).map((p, i) => ({ participantId: p, observation: i === 0 ? "질문으로 끝나는 메시지가 많다" : "'좋지'로 받고 날짜는 안 낸다", evidenceIds: [idAt(6 + i)], device: "CONTRAST" })),
      conflicts: [],
      plans: [{ proposedMessageId: idAt(1), what: "카페 가기", followedThrough: "UNKNOWN", evidenceIds: [idAt(1)] }],
      safetyFlags: [],
    };
  }

  private synthesis(h: NonNullable<StageRequest<unknown>["hints"]>, idAt: (i: number) => string, bogus: string[], hanja: string, forbidden: string, hasQuestion = false): ReportDraft {
    const ps = h.participantIds;
    const participants: ReportDraft["participants"] = (this.scenario === "missing_participant" ? ps.slice(0, Math.max(1, ps.length - 1)) : ps).map((p, i) => {
      const own = h.messageIds.filter((id) => h.speakerOf[id] === p);
      const q1 = own.length ? [own[Math.floor(own.length / 2)]] : [];
      const q2 = own.length > 1 ? [own[own.length - 1]] : [];
      return {
        participantId: p,
        emoji: i === 0 ? "🔌" : i === 1 ? "🛋️" : "👻",
        title: i === 0 ? "질문은 던지고 답은 기다리는 '전원 버튼 담당'" : i === 1 ? "'좋지'는 즉답이고 날짜는 무응답인 '좋지 머신'" : `접속은 하고 글은 안 쓰는 '눈팅 ${i + 1}호'`,
        nickname: i === 0 ? "전원 버튼 담당" : i === 1 ? "좋지 머신" : `눈팅 ${i + 1}호`,
        type: { label: i === 0 ? "떡밥 투척 갤주형" : i === 1 ? "프로 보류러형" : "눈팅족형", description: i === 0 ? "방이 조용하면 제일 먼저 질문을 던지고 답이 없으면 또 던진다." : "제안엔 1초 만에 '좋지'를 치고 날짜 얘기가 나오면 사라진다." },
        topics: i === 0 ? ["주말 약속", "카페 투어", "수업 끝나고 뭐 하기"] : i === 1 ? ["ㅇㅇ", "나중에", "다음에 보자"] : ["생존 신고"],
        paragraphs: [
          {
            text: i === 0 ? `${p}는 이 방의 갤주다. 떡밥은 다 이 사람이 던지고, 아무도 안 물면 본인이 물어서 끌고 간다. 대화의 전원 버튼이 이 사람 손에 있다는 걸 본인만 모른다${hanja}.` : `${p}는 '좋지'로 받고 날짜는 안 낸다. 제안이 오면 1초 컷으로 '좋지'를 치는데, 그 뒤에 날짜 얘기가 나오면 안읽씹 상태로 들어간다${forbidden}. 결론: 동의는 즉시, 실행은 외주.`,
            quoteIds: q1,
          },
          {
            text: i === 0 ? "웃긴 건 질문을 던지고 답이 오기 전에 다음 질문을 던진다는 점이다. 상대가 답을 고르는 동안 선택지가 두 배가 된다. 그래도 이 방이 아직 살아 있는 건 이 사람 덕분이라는 건 전원이 안다." : "그래도 먼저 '보자'고 한 적이 한 번은 있다. 그거 할 줄 아는 사람이면 날짜도 박을 수 있다.",
            quoteIds: q2,
          },
        ],
        badgeIds: i === 0 ? ["first_texter"] : i === 1 ? ["slow_burner"] : [],
      };
    });
    const num = h.numbers[0] ?? 71;
    const scores = h.scoreKeys.map((key, i) => ({ key, value: h.priors[key] ?? 50 + i * 7, oneLiner: `${key}: 숫자 ${h.numbers[i] ?? num} 기준. 보고 끝.`, confidence: "MEDIUM" as const }));
    return {
      verdict: {
        reportTitle: "좋지 보고서: 동의는 즉시, 실행은 외주",
        headline: "둘 중 한 명만 연애 중이다",
        body: [
          `결론부터. 선톡 ${num}%는 한 사람 몫이야. 이건 대화가 아니라 방송이야.`,
          `그런데 ${idAt(4)}를 봐. 침묵을 깬 것도 같은 사람이야.`,
          "진짜였던 건 초반이고, 바뀐 건 중반이야. 그 뒤로 역전이 없어. 그래도 둘이 웃는 건 진짜야. 문제는 마음이 아니라 손가락이야.",
        ],
        relationType: { code: "ONE-WAY", label: "한쪽만 달리는 사이", description: "선톡·질문·답장 속도가 한쪽으로 기울어 있다." },
        confidence: "HIGH",
      },
      dynamic: {
        paragraphs: ["한쪽은 질문하고 한쪽은 평가한다. 역은 드물다.", "계획은 한쪽이 내고 다른 쪽은 '좋지'로 받는다."],
        groupRoles: ps.length > 2 ? { holdsTogether: ps[0], goesQuiet: ps[ps.length - 1], runsTheShow: ps[1] ?? null } : { holdsTogether: null, goesQuiet: null, runsTheShow: null },
        evidenceIds: [idAt(8), ...bogus],
      },
      firstMove: {
        initiatorId: ps[0] ?? null,
        pretenderId: ps[1] ?? null,
        body: `먼저 치는 건 ${ps[0]}. 선톡 ${num}%가 숫자로 말해줘. 아닌 척하는 건 ${ps[1] ?? ps[0]}, 답은 늦게 하고 웃음은 많이 보내(${idAt(22)}).`,
        evidenceIds: [idAt(22)],
      },
      privateLanguage: {
        phrases: [{ phrase: "좋지", meaning: "이 대화에서 '좋지'는 동의가 아니라 보류다.", evidenceIds: [idAt(23)] }],
        runningJokes: [{ title: "담에 보자", summary: "'담에'가 나오면 다음 메시지까지 평균 이틀이 비는 농담.", evidenceIds: [idAt(24)] }],
      },
      weekChanged: {
        exists: true,
        weekLabel: "2025년 6월 둘째 주",
        weekStart: "2025-06-09",
        before: "바뀐 주는 2025년 6월 둘째 주다. 그 전엔 하루에도 몇 번씩 오갔다.",
        after: "그 주부터 질문만 남고 답은 짧아졌다.",
        pivotMessageId: idAt(9),
        evidenceIds: [idAt(9)],
        confidence: "MEDIUM",
      },
      participants,
      findings: [
        { title: "선톡은 한 사람 몫", observed: `선톡 비율이 ${num}%로 기울어 있다.`, interpretation: "대화의 전원 버튼이 한 손에 있다는 뜻이다.", evidenceIds: [idAt(10), ...bogus], confidence: "HIGH", tags: ["initiative"] },
        { title: "'좋지'와 날짜 사이", observed: "계획 제안에 긍정 반응은 많고 날짜는 적다.", interpretation: "열린 질문엔 '좋지', 닫힌 질문엔 날짜가 나온다.", evidenceIds: [idAt(11)], confidence: "MEDIUM", tags: ["follow_through"] },
        { title: "새벽에 더 솔직하다", observed: "새벽 메시지가 특정 시기에 몰려 있다.", interpretation: "낮과 밤의 온도가 다르다.", evidenceIds: [idAt(12)], confidence: "LOW", tags: ["rhythm"] },
        { title: "침묵을 깨는 쪽은 늘 같다", observed: "긴 침묵 뒤 첫 메시지는 같은 사람이 보냈다.", interpretation: "기다리는 쪽과 잊는 쪽이 정해져 있다.", evidenceIds: [idAt(13)], confidence: "MEDIUM", tags: ["effort"] },
      ],
      whatIWouldDo: [
        { title: "이번 주는 먼저 안 보낸다", body: "내가 너라면 이번 주는 먼저 안 보낸다. 셋 중 하나는 확인된다: 오거나, 안 오거나, 네가 편해지거나.", deadline: "이번 주" },
        { title: "두 개 중 고르게 한다", body: "내가 너라면 다음 계획은 두 날짜 중 고르게 한다. 열린 질문엔 '좋지'만 돌아온다.", deadline: "다음 선톡 전에" },
        { title: "새벽 ㅋㅋ는 증거가 아니다", body: "내가 너라면 새벽 웃음을 노력의 증거로 쓰지 않는다. 그건 재미의 증거다.", deadline: "항상" },
      ],
      awards: [
        { name: "읽씹 장인상", participantId: ps[1] ?? ps[0], reason: "답장이 가장 느리다", evidenceIds: [idAt(14)] },
        { name: "편집장상", participantId: ps[0], reason: "대화를 가장 많이 시작했다", evidenceIds: [idAt(15)] },
        { name: "올해의 한 줄상", participantId: null, reason: "침묵을 깬 한 줄", evidenceIds: [idAt(16)] },
      ],
      scores,
      moments: [
        { kind: "funny", caption: "둘 다 웃은 순간", messageIds: [idAt(17)] },
        { kind: "awkward", caption: "답이 하루 늦게 온 순간", messageIds: [idAt(18)] },
        { kind: "banter", caption: "티키타카", messageIds: [idAt(19), idAt(20)] },
        { kind: "touching", caption: "먼저 사과한 순간", messageIds: [idAt(21)] },
      ],
      visualCaptions: { monthly: "최다 달과 최저 달의 차이가 이 관계의 온도차다.", heatmap: "골든아워는 밤이다.", reply: "답장 속도 차이가 곧 관심 차이는 아니지만, 보통은 그렇다.", initiation: `선톡 ${num}%. 전원 버튼은 한 손에 있다.` },
      answer: hasQuestion ? { body: `짧게 답할게. 관심은 있어. 근데 ${idAt(4)}를 보면 그 관심이 손가락까지 내려오진 않아. 숫자로는 선톡 ${num}%가 답이야.`, confidence: "MEDIUM", evidenceIds: [idAt(4)] } : null,
      shareCard: { headline: "둘 중 한 명만 연애 중이다", subline: `읽씹 장인상 수상자 있음 · 선톡 ${num}%` },
      safetyFlags: [],
    };
  }

  private repair(user: string, idAt: (i: number) => string): RepairResponse {
    // 위반 path 목록을 읽어 무해한 교체값을 돌려준다
    const paths = [...user.matchAll(/^- ([^:]+):/gm)].map((m) => m[1].trim());
    return {
      patches: paths.map((path) => {
        if (path === "verdict.headline") return { path, valueJson: JSON.stringify("둘 중 한 명만 연애 중이다") };
        if (path === "verdict.reportTitle") return { path, valueJson: JSON.stringify("좋지 보고서: 동의는 즉시, 실행은 외주") };
        if (/^participants\[\d+\]\.paragraphs\[\d+\]$/.test(path)) return { path, valueJson: JSON.stringify({ text: `선톡과 질문을 맡고 있다(${idAt(1)}). 수리된 문단이지만 화법은 유지한다.`, quoteIds: [] }) };
        if (/^participants\[\d+\]\.paragraphs$/.test(path)) return { path, valueJson: JSON.stringify([{ text: `선톡과 질문을 맡고 있다(${idAt(1)}). 재료가 모자라 한 문단으로 보고한다.`, quoteIds: [] }]) };
        if (/^participants\[\d+\]\.(title|nickname)$/.test(path)) return { path, valueJson: JSON.stringify("수리된 '별명'") };
        if (/^participants\[\d+\]$/.test(path)) return { path, valueJson: JSON.stringify(null) };
        if (/^findings\[\d+\]$/.test(path)) return { path, valueJson: JSON.stringify({ title: "수리된 발견", observed: "보인 것", interpretation: "해석", evidenceIds: [idAt(2)], confidence: "LOW", tags: [] }) };
        return { path, valueJson: JSON.stringify("수리됨") };
      }),
    };
  }
}
