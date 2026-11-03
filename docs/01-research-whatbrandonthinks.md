# 01. 조사 보고: What Brandon Thinks 와 유사 서비스·오픈소스

> 조사일 2026-11-03. 공식 사이트(www.whatbrandonthinks.com)와 대다수 리뷰 사이트는 이 세션의 네트워크 정책에 막혀 **직접 열지 못했고**, 검색 엔진 요약·미러 도메인·디렉터리 설명·GitHub 저장소를 교차 검증했다. 따라서 "리포트 실제 문구/섹션 순서"는 **미검증**이며, 사용자가 공유한 리포트 URL(`/ko/c/{uuid}/reports/1`)을 열 수 있게 되면 07 문서의 스키마를 보정한다.

---

## 1. 서비스 개요

| 항목 | 내용 | 신뢰도 |
|---|---|---|
| 한 줄 정의 | 메신저 대화 내보내기 파일을 올리면 AI 캐릭터 "Brandon"이 전부 읽고 **솔직한 보고서**를 써주는 서비스. "An AI that reads your chat and tells you what it really thinks." | 높음(공식 FAQ 요약) |
| 제작사 | GumGum — 파리의 프로덕트 랩, 형제 Matthias·Robin 창업. 자매 앱 Moka Score(한 관계 점수화, 무료), GumGum Creators(TikTok/Instagram 크리에이터 팀) | 높음(공식 About) |
| 출시·규모 | 2026년 출시, 65만+ 보고서 작성(자사 주장). TikTok에서 "what brandon thinks" 리액션 영상이 월 수천만 뷰(자사 주장) | 중간 |
| 지원 플랫폼 | WhatsApp, iMessage, Instagram, Messenger, KakaoTalk, LINE (공식 About). 카카오톡은 폰에서 내보내기→이메일 전송 또는 PC에서 파일 업로드 | 높음 |
| 입력 제한 | WhatsApp ZIP/TXT, iMessage TXT, 25MB 이하(디렉터리 설명) | 중간 |
| 흐름 | ① 내보내기(약 5분, 플랫폼별 튜토리얼) → ② 업로드 또는 이메일로 보내기 → ③ 참여자 선택·"내가 누구인지"·보고서 초점 선택 → ④ 이메일 확인 후 **무료 미리보기**(판정 + 5개 점수 + 발견 2개) → ⑤ 결제 시 전체 보고서. 생성 약 10분, 링크를 메일로 전달 | 중간~높음 |
| URL 구조 | `/{locale}/c/{conversationUuid}/reports/{n}` — 대화(업로드) 1건에 번호가 붙는 보고서 N개 | 높음(사용자 제공 URL) |
| 가격(공식 pricing 페이지 요약) | Classic €9.99 1회(발견 6개 전부, 전환점, 인물별 평, 행동 계획) · Deep €14.99 1회(상세 + **내 질문 1개**) · Unlimited €29.99/월(무제한 Deep, 우선 생성, 히스토리, 월 1회 Friend Pass) | 중간(사이트별 상이, USD 표기 미러 존재) |
| 프라이버시 | 파리 소재 → GDPR. 업로드는 자동 삭제(보고서 미생성 시 48시간 내), 사용자가 즉시 삭제 가능, AI 제공자는 학습 금지 계약, 보고서는 비공개 기본·공유 중단/삭제 가능 | 중간 |
| 면책 | "마음을 읽는 것이 아니라 관찰 가능한 패턴을 해석" / "재미와 성찰용, 진단·법률·전문 조언 아님" | 높음 |

## 2. 보고서 구조 (복수 출처 교차)

> **중요 정정(2026-11-03)**: 공식 FAQ는 "Brandon의 이름·얼굴·보고서를 쓰는 다른 사이트·앱은 우리가 아니다"라고 명시한다. 아래 §2의 "점수 5개·발견 6개·검증된 순간·confidence 라벨" 구조는 **.org/.net/.app/what-brandon-thinks.com 등 클론 사이트**의 샘플에서 나온 것이다. **공식(.com About/FAQ)이 직접 밝힌 뼈대**는 다음과 같다:
> **판정(verdict) → 두 사람(또는 방)의 진짜 역학 → 바뀐 주(the week things changed) → Brandon이 내 입장이라면 할 일** + 단톡방은 **모든 멤버에 대한 의견**(누가 판을 유지하고, 누가 조용해지고, 누가 판을 쥐는지), 멤버 누구나 개인 보고서 가능. 결제는 "보고서당 1회, 구독 없음"(About). 가격표(€9.99/14.99/29.99)는 클론 사이트 출처라 공식 여부 불명.
> 화법 분석은 14 문서에 정리했고, 제품 설계(07)는 공식 뼈대를 중심으로 재정렬했다. 클론 구조는 "공유용 부가 섹션" 참고로만 남긴다.

클론/미러 "sample report"와 디렉터리 설명을 합치면 전체 보고서는 다음 블록으로 구성된다.

1. **Verdict(판정)** — Brandon의 총평. 스크린샷해서 단톡방에 보내도록 설계된 짧고 강한 문장 + 설명 문단.
2. **Five scores(점수 5개)** — 각 5점 만점(또는 100점). 샘플에서 확인된 이름: *Reply Radar*(답장 레이더), *Repair Reflex*(갈등 회복 반사), *Follow-Through*(약속 이행). 나머지 2개는 미확인(관계 초점에 따라 interest/effort/tone/mixed signals 계열로 추정).
3. **Turning point(전환점)** — "무엇이 언제 바뀌었나". 샘플: 막연한 열의 → 시점이 정해지며 구체적 계획으로 전환.
4. **Participant reads(인물별 읽기)** — 모든 참여자에 대한 **한 줄 솔직 평**. 단톡방이면 역할: "누가 판을 유지하고, 누가 조용해지고, 누가 판을 쥐는지".
5. **Six findings(발견 6개)** — 각 발견은 짧은 **근거 발췌(원문에 실제 존재하는지 대조 검증)** + **confidence 라벨**을 단다.
6. **Verified chat moments(검증된 순간들)** — 실제 메시지 인용 카드.
7. **Action plan / what to do now** — 전체 보고서에서 발견 6개를 실천 계획으로 묶음.
8. (Deep) **사용자 질문 1개에 대한 답**.

무료 미리보기 = 1 + 2 + 발견 2개. 미리보기도 "personal" (실제 대화 기반).

### 2.1 톤·"재미"의 원천 (제품 카피·리뷰·사용자 반응 종합)
- 페르소나: "다 겪어본 친구가 솔직하게 말해주는" 톤. "No sugar-coating, but not mean either." 리뷰 표현: *part roast, part reflection*. 톤은 "대화와 Brandon의 기분에 따라" 달라진다(의도적 변동성).
- 재미는 **구체성**에서 나온다: 누가 먼저 연락했고, 누가 물러났고, 에너지가 어디서 꺼졌는지, 새벽 메시지 패턴 같은 실제 관찰 + 인물별 한 줄 평(candid one-line takes).
- **공유 설계**: 판정 문장은 스크린샷용, 단톡방 보고서는 "모든 멤버에 대한 의견"이라 서로 돌려보게 된다(바이럴 루프).
- **신뢰 장치**가 재미를 뒷받침: 근거 발췌 대조 검증, confidence 라벨, "마음을 읽는 게 아님" 면책. 근거 없는 로스트는 금방 식는다.

## 3. 경쁁/유사 서비스

| 서비스 | 형태 | 가격 | 특징 |
|---|---|---|---|
| MosaicChats | 웹, WhatsApp/Messenger 등 | 무료(주 50회 업로드, 워드클라우드, 관계 강점) / Pro $9.99/월(첫 달 $1) | 감정 타임라인, 호환성 점수, 성격, AI 코치 채팅 |
| The Grey Mirror (JustLayMe) | 앱 | 보고서 1건 $17.99 / Plus $9.99/월 | "30개 분석기, 47개 모델", 처음 4개 발견 무료, 증거 섹션 |
| WhatsAnalyze | 웹(브라우저 내 처리, 오픈소스) | 무료 / Pro €9.99 | 온디바이스 통계·요약, Wrapped 연말 결산, PDF/이미지 내보내기 |
| Moka Score (GumGum) | 웹 | 무료 | 한 관계 점수 + 방향 |
| **톡사이(toksai)** (한국, 오픈소스) | Next.js+NestJS+Gemini | 무료 | 1:1 관심 신호 타임라인·선톡·답장속도·케미 지수·뱃지·관계 유형. **프롬프트/스키마/인용 검증 코드 공개** |
| Tokka(톡까) | React+FastAPI+Gemini | 무료 | 3-패스 청크 분석(500~800개 메시지 청크 → 인물 프로필 통합 → SNS 콘텐츠). "AI 분석보다 공유 UX가 핵심 가치" |
| 톡시그널 | 웹 | 990원 | 카톡 호감도·감정 온도 |
| 톡판정 | 앱 | 무료 | 스크린샷 기반 갈등 점수 |
| 카나나 in 카카오톡 | 카카오 공식 | 무료 | 온디바이스 대화 요약·성격/MBTI 분석(정확도 지적) |

시사점: 한국 시장에 "공개 링크로 공유하는 1:1 재미 리포트"는 있지만, **단톡방 전원에 대한 솔직 판정 + 근거 검증 + 스크린샷용 판정 문장**이라는 Brandon식 포맷은 비어 있다.

## 4. 오픈소스·프롬프트 조사 결과

- **Brandon의 프롬프트는 공개된 것이 없다.** TikTok에 "what brandon thinks prompt" 토픽이 있지만 공유 프롬프트 템플릿은 확인되지 않음(리액션 영상 위주). 재현은 자체 프롬프트 설계로 간다.
- **toksai**(`Todari/toksai`, GitHub): 가장 완성도 높은 한국어 참고 구현. 가져올 것: ① 파서(iOS/PC/CSV/BOM/분할 파일/12·24h) ② 통계(`compute-stats`, `fun-facts`: 골든아워, 최장 침묵, 선톡, 답장 중앙값, 대화 종결자) ③ 월별 버킷 → 종합 2단계 프롬프트 ④ Zod/JSON 스키마 강제 ⑤ **인용 접지(grounding) 검증**(NFKC 정규화 후 부분 문자열 대조, 미접지 인용 제거·카운트) ⑥ 잡 하트비트·stale 복구·커버리지 임계(60%). 라이선스는 구현 전 확인.
- **kakaothread**(`0-ki/kakaothread`, AGPL-3.0): PC/모바일 포맷 자동 감지, 봇·입퇴장 제거, 연속 메시지 병합, 세션 분할, `--dry-run` 비용 추정, 다중 프로바이더 슬롯 풀. AGPL이므로 **코드 복사 금지**, 아이디어만 참고.
- **kakaotalk-export-parser**(hyundo32-copilot): 미디어 플레이스홀더 분류, 시스템 메시지 3종, 인코딩 폴백(utf-8 → utf-8-sig → euc-kr).
- **kakao_reply**(doheon-code): PC/Android/iOS 정규식 + CP949 폴백 + 샘플 픽스처.
- **kakao-chat-summary**(YeonHongMin): 한국어 요약 프롬프트. 교훈: "한자·일본어 출력 금지" 같은 **출력 언어 검증 규칙**이 실제로 필요했다.
- 실측 샘플(`drwon-cmd/kakaotalk-import`)에서 **영문 로케일 내보내기 포맷** 확인: `2 October 2026 at 9:02 am, Name : text`, `X invited A, B and C.`, `The message has been deleted.`, 헤더 `KakaoTalk Chats …`, `Date Saved : …`.
- 유머 생성 연구: HumorPlanSearch(계획→생성 분리), 스탠드업 연구(아이러니·과장·부조리 등 기법을 프롬프트 수사 층에 명시), 로스트 가이드(정체성·보호 속성 대신 **행동·습관**만 로스트, 비동의자 로스트 금지).

## 5. 우리 제품에 반영할 결론

1. 포맷을 그대로 따른다: **판정 → 점수 5개 → 전환점 → 인물별 한 줄 평 → 발견 6개(근거+신뢰도) → 검증된 순간 → 지금 할 일**. 여기에 결정적 통계 비주얼(월별 양, 시간대 히트맵, 답장 속도, 선톡 비율)을 더해 "숫자로 때리는 로스트"를 가능하게 한다.
2. 재미의 품질은 **근거 접지**가 만든다: LLM이 메시지 ID를 인용하고 서버가 검증·렌더링(텍스트 환각 0). 미접지 발견은 신뢰도 하향 또는 제거.
3. 페르소나는 설정값: 기본 "까비서"(가제), 반말/존댓말 선택, "솔직하지만 잔인하지 않음" 규칙과 금지 영역(보호 속성, 외모, 정신건강 진단, 자해·학대 신호 시 톤 전환) 고정.
4. 공유 루프: 판정 카드(스크린샷 최적화) + 비공개 공유 링크(토큰, 철회 가능) + 단톡방 멤버 전원 평.
5. 수익화는 MVP 범위 밖이되, **미리보기/전체** 게이팅 플래그와 "내 질문 1개(Deep)" 입력을 데이터 모델에 미리 둔다.
6. 1건의 대화에 보고서 N개(초점·질문·참여자 매핑 변경) — URL `/c/{id}/reports/{seq}`.

## 6. 출처
- 공식: whatbrandonthinks.com (`/`, `/about`, `/faq`, `/relationship`, `/friends`, `/imessage`), gumgumcreators.com/whatbrandonthinks, gumgum.app, mokascore.com
- 미러/디렉터리(가격·샘플 구조): what-brandon-thinks.com(`/sample-report`, `/pricing`, `/safety`), whatbrandonthinks.org(`/sample-report`), whatbrandonthinks.app(`/review`, `/free`), whatbrandonthinks.net, sidehunt.io, uneed.best, tinylaunch.com, fazier.com, dang.ai, aitoolboard.com, finderlaunch.com, Google Play `co.whatbrandonthinks.app`
- 경쟁: mosaicchats.com/what-brandon-thinks-alternative, thegreymirror.com/grey-mirror/relationship-report-pricing, whatsanalyze.com/what-brandon-thinks-alternative, jiun.dev/posts/tokka-kakaotalk-analysis, toksignal.kr
- 오픈소스: github.com/Todari/toksai, github.com/0-ki/kakaothread, github.com/hyundo32-copilot/kakaotalk-export-parser, github.com/doheon-code/-, github.com/YeonHongMin/kakao-chat-summary, github.com/gaoyuanshanzi/kakaotalk-chat-viewer, github.com/deeprine/kakaotalk_chat_analysis_web, github.com/graup/kakaotalk-analyzer, github.com/drwon-cmd/kakaotalk-import
- 유머/프롬프트: arXiv 2508.11429(HumorPlanSearch), arXiv 2602.12763, chatai.guide 로스트 가이드
