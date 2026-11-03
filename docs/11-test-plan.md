# 11. 테스트 계획

> 2026-11-03 Node 구현 기준으로 갱신 (docs/18 P0-9). 도구는 **vitest**. 케이스 표의 제목은 `tests/**/*.test.ts`의 `describe`/`it` 문자열을 그대로 옮겼다. 코드에 없는 테스트는 **미구현**으로 표기한다(JUnit·Testcontainers·WireMock 서술은 제거).

## 1. 레벨별 구성
| 레벨 | 도구 | 대상 | 실행 | 상태 |
|---|---|---|---|---|
| 단위 | vitest (`vitest.config.mts`: `environment: node`, `include: tests/**/*.test.ts`, 타임아웃 60s, `setupFiles: tests/setup.ts`, alias `@ → src`) | `tests/parser.test.ts`, `tests/stats.test.ts`, `tests/report.test.ts` | `pnpm test`(= `vitest run`), `pnpm test:watch` | 구현 |
| 통합 | vitest + **실제 PostgreSQL** `ggai_test` + `FakeLlmClient` | `tests/integration/flow.test.ts` — 서비스 함수를 직접 호출(HTTP 레이어 없음) | 같은 `pnpm test`. DB는 `.env.test`의 `DATABASE_URL`(`127.0.0.1:5433/ggai_test`)가 떠 있어야 함. `beforeAll`에서 마이그레이션 적용 후 `TRUNCATE` | 구현 |
| E2E 스모크 | `scripts/smoke.sh` (bash + curl + python3) | 실제 web + worker 상대로 업로드(`signal` 확인)→확인→생성→폴링→공유→카드 PNG→보고서 단위 삭제→페이지→대화 삭제 | `pnpm smoke` (`BASE_URL`, `FIXTURE`, `KEEP=1`) | 구현 |
| 스크린샷 | `scripts/screenshots.cjs` (Playwright, **전역 설치** 전제·의존성에 없음) | 랜딩·위저드 1단계·스토리 1/2/3/7장·보고서·대시보드 PNG 9장(모바일 430×900@2x, 데스크톱 1280×900) | `node scripts/screenshots.cjs <baseUrl> <cookieJar> <conversationId> <seq> <outDir>` — 스모크 `KEEP=1` 출력의 쿠키 jar·ID 사용 | 구현(수동) |
| 계약(LLM 응답 형태) | - | `AnthropicLlmClient`의 refusal/max_tokens/429 처리 | - | **미구현**(nock·MSW 없음, §4) |
| 품질 eval | `scripts/eval.ts`(tsx) | 픽스처(또는 지정 파일) → 단일 패스 종합 → 검증 지표 + 14 §6 화법 수치. 기본 `FakeLlmClient`, `LLM_PROVIDER=anthropic`이면 실제 Claude 호출(비용 발생) | `pnpm eval [파일…]`(수동) | 구현(결정적 지표만; LLM 심사·가상 대화 6종 세트는 미구현, §5) |
| 성능 | - | 50MB 파싱·30만 메시지 통계 | - | **미구현**(§6) |
| 보안 | 단위 일부 | zip 경로 탈출·비텍스트 무시·확장자·인코딩 | `pnpm test` | 부분(§7) |

`tests/setup.ts`: `.env.test` → `.env` 순으로 로드, 없으면 `APP_CRYPTO_KEY`(더미 32B)·`LLM_PROVIDER=fake`·`APP_BASE_URL` 기본값. `.env.test`는 `UPLOAD_MIN_MESSAGES=1`, 레이트리밋 1000, `WORKER_STALE_MINUTES=3`.

## 2. 단위 테스트 명세 (구현된 케이스)

### 2.1 파서 `tests/parser.test.ts`
- `describe "parser golden (docs/fixtures/*.expected.json)"` — `docs/fixtures/*.expected.json`을 동적으로 순회(12종, `expect ≥ 12`): `android_ko_basic` · `cp949` · `edge_body_looks_like_date` · `edge_colon_in_body` · `empty_or_garbage`(기대 `error: NO_MESSAGES`) · `en_android` · `group_30people` · `ios_dotted_12h` · `ios_dotted_24h` · `mixed_split_merge`(디렉터리, 파일 2개) · `pc_bracket` · `pc_csv`. 비교 필드: `title`, `sourceFormat`, `messageCount`, `warnings`, `participants`, `messages`(필드 단위 `toEqual`). 기대값은 `docs/tools/spec_parser_prototype.py --write-expected`로 생성 후 사람이 검토(03 §7). 변경은 의도적 갱신만.
- `describe "parser rules"`:
  | it | 검증 |
  |---|---|
  | `is deterministic` | 같은 입력 2회 파싱 결과 `toEqual` |
  | `12h conversion: 오전 12→0, 오후 12→12, 오후 1→13, 오전 8→8` | iOS 점 포맷 4줄 |
  | `rejects too few messages / too many participants` | `TOO_FEW_MESSAGES`(min 30), `TOO_MANY_PARTICIPANTS`(70명 > 60) |
  | `decodes UTF-16LE with BOM and rejects undecodable bytes` | UTF-16LE BOM 디코딩, 깨진 바이트 → `ParseError` |
  | `zip: extracts only txt/csv, rejects path traversal` | `photo.jpg` 무시, `../etc/passwd.txt` → `ZIP_UNSAFE_ENTRY`, zip 업로드 파싱 성공 |
  | `rejects unsupported file types` | `.docx` → `UNSUPPORTED_FILE_TYPE` |
- 미구현(이전 계획 대비): 개별 규칙 테스트 다수(첫 `" : "`만 구분자, 멀티라인, 헤더 비병합, 날짜 구분선 3종 …)는 골든 픽스처가 간접 검증. 퍼징(무작위 줄 1,000회)·타임아웃 테스트 없음.

### 2.2 통계·Tier 0 `tests/stats.test.ts` — `describe "computeStats"`
| it | 검증 |
|---|---|
| `counts kinds, participants, heatmap and monthly totals consistently` | `android_ko_basic`: 메시지 14(시스템 2 제외)·텍스트 10·사진 1·이모티콘 1·파일 1·삭제 1·시스템 2, 히트맵 합 = 월별 합 = 14, 참여자 3명, 3명이라 `balance` null |
| `session gap boundary: 5h59 same session, 6h00 new session` | 세션 2개, 선톡 A 2/B 0, B 답장 1(중앙값 359분), 세션 경계 넘은 건 답장 아님, `balance.uploaderId`·`initiationRatio 1` |
| `excluded participants create context breaks that block reply attribution` | 제외 참여자가 끼어든 뒤 답장은 집계되지 않음(`replyCount 0`) |
| `priors, facts and tier0 are produced for a group fixture without forbidden words` | `group_30people`: 참여자 31, GROUP prior 키 5개 순서, 사실 문장 > 10, `allowedNumbers`에 총 메시지 수 포함, Tier 0 헤드라인·라인 ≥3·어워드 ≤6, 금지어(뚱/못생/장애/우울증/자살) 0, 같은 seed → 동일(결정성) |
| `pair tier0 picks one-way headline when lean is strong` | 20일 합성 1:1: `balance.lean > 0.3`, `relationLabel "한쪽만 달리는 사이"`, 어워드에 "읽씹 장인상" |
- 미구현: 균형 지표 부호 전수, fun facts 각 항목(골든아워·종결자) 개별 검증, 신호 등급 임계값(3000/30·800/10·200) 직접 테스트(통합 #1이 `WEAK`만 확인).

### 2.3 전사·플래너 `tests/report.test.ts`
| describe / it | 검증 |
|---|---|
| `transcript` / `masks phone/account/url and keeps message ids deterministic` | `maskText("연락은 010-1234-5678로, 계좌 110-123-456789, https://www.example.com/a?b=1")` → `"연락은 [전화번호]로, 계좌 [계좌], [링크: example.com]"`; 전사 첫 줄 `m0 [2026-09-25 20:02] 박민수(나): 오늘 수업 끝나고 뭐해?`, `[사진]`, `[파일: 주말계획.pdf]`, 시스템 줄 미포함 |
| `planner` / `single pass for small transcripts, chunked with month buckets for large ones` | 소형 → `SINGLE`, 커버리지 100; 토큰 4만×6개월 → `CHUNKED` 2청크+, `chunkByMonth` 빈 청크 없음 |
| `planner` / `samples to coverage < 100 when exceeding max total tokens and throws when cost cap is impossible` | 총량 초과 → 커버리지 < 100; `maxCostUsd 0.01` → `COST_LIMIT_EXCEEDED` |
- 미구현: 주민번호 마스킹 양·음성 케이스, 멀티라인 들여쓰기, 모드 경계값(150k 정확히), 비용 추정 공식 값 검증.

### 2.4 검증기·어셈블러 `tests/report.test.ts` — `describe "validator + assembler"` (`FakeLlmClient` 초안 사용)
| it | 검증 |
|---|---|
| `accepts a clean fake draft and assembles full content with evidence text filled` | `ok` 시나리오: `MISSING` 외 위반 0, `schemaVersion 1`, 참여자 전원, 점수 5, 발견 근거 텍스트 채움, `weekChanged.pivot.text`, 서명, `resolvedFocus`(AUTO·3인 → `FRIENDS_GROUP`) |
| `scrubs unknown inline message ids from prose and exposes known ones as inlineEvidence` | 산문 속 존재하지 않는 `m999999`는 제거되고 `inlineEvidence.m999999` 없음, 존재하는 ID는 `content.inlineEvidence[id].text` 채움 |
| `drops hallucinated ids and counts them` | `m999999` 제거, `evidenceDropped ≥ 2`, 점수 비활성 시 `[]` |
| `flags non-korean script and forbidden topics, then enforceFinal removes them` | `hanja` → `NON_KOREAN_SCRIPT` → `enforceFinal` 후 재검증 0; `forbidden` → `FORBIDDEN_TOPIC` |
| `reports missing participants and applies repair patches` | `missing_participant` → `participants[…] MISSING`; `applyPatches`로 헤드라인 교체·`findings[0]` null 삭제 |
| `clamps scores to prior ±40 and downgrades confidence` | 100점 입력 → prior ±40 이내 |
- 미구현: 숫자 불일치(`unverifiedNumbers`) 값 검증, 상담사 톤 위반, 산문 속 UUID→이름 치환(`mapProseStrings`), 배열 길이 절단 경계.

### 2.5 프롬프트 `tests/report.test.ts` — `describe "prompts"`
| it | 검증 |
|---|---|
| `system prompt is byte-stable and has no volatile content` | 2회 호출 동일, 날짜(`YYYY-MM-DDT`)·UUID 패턴 없음, "까비서"·"반말"·"존댓말은 쓰지 않는다"·"인물 페르소나"·"갤주"·"뻔함 금지" 포함 |
| `synthesis prompt carries facts, priors, mood and question` | "DRY(건조)", 질문 문구, `<transcript>`, `participation_balance` 포함 |
- 골든 문자열 스냅샷은 두지 않는다(변경 잦음).

### 2.6 도메인 상태 머신·참여자 규칙
단위 테스트 없음. 전이 규칙은 §3 통합 #4(409 `REPORT_ALREADY_RUNNING`), #6(성공 후 재실행 `skipped`), #7(FAILED→retry→QUEUED→SUCCEEDED, `attemptCount 2`), #9(취소 후 `skipped`, 재취소 409 `INVALID_STATE`), #10(stale → QUEUED)으로, 참여자 규칙은 #3(업로더 제외 시도 → 400)으로 검증한다. 미구현: 비허용 전이 전수, `MERGE_CHAIN`, 자기 병합, 업로더 미선택(null) 경로의 `balance null`·프롬프트 분기.

## 3. 통합 테스트 `tests/integration/flow.test.ts` — `describe "end-to-end service flow"` (실 Postgres + FakeLlmClient)
`FakeLlmClient`(`src/lib/llm/fake.ts`): `hints`(전사 ID 집합·화자 맵·참여자 ID·허용 숫자·점수 키·prior)에서 **결정적으로** 근거를 고르고 고정 템플릿 JSON을 돌려준다. 시나리오(`FakeScenario`, 환경변수 `FAKE_LLM_SCENARIO` 또는 생성자 인자):
| 시나리오 | 동작 |
|---|---|
| `ok` | 정상 초안(판정·역학·firstMove·privateLanguage·바뀐 주·전원·발견 4·제안 3·어워드 3·점수·순간 4·질문 있으면 answer) |
| `hallucinate_ids` | 근거 배열에 존재하지 않는 `m999999` 추가 |
| `hanja` | 인물 선언문에 " 推荐" 삽입 |
| `forbidden` | 인물 선언문에 " 뚱뚱해서 그래" 삽입 |
| `refusal` | `LlmError("LLM_REFUSED", retryable false)` throw |
| `rate_limit` | `LlmError("LLM_UNAVAILABLE", "fake 429", retryable true)` throw |
| `missing_participant` | 마지막 참여자 항목 누락(검증기 `MISSING` → REPAIR 경로) |
수리 요청에는 위반 path별 무해한 교체값을 돌려준다. `usage`는 길이 기반 추정, `cacheRead`는 시스템 프롬프트 길이.

| # | it | 검증(순서 의존, 같은 대화 사용) |
|---|---|---|
| 1 | `uploads, parses, builds tier0 story and dedupes re-upload` | `android_ko_basic.txt` + `focus: FRIENDS_GROUP` → `reused false`, 포맷, 참여자 3명, `tier0.story` 7장 키 순서(`overview, who_more_who_first, rhythm, longest_messages, first_day, last_day, frequent_words`), `tier0.signal "WEAK"`, `defaultFocus`, `rawAvailable`; 같은 소유자 재업로드 → `reused true` 동일 ID; 다른 소유자 → 새 대화 |
| 2 | `hides conversations from other owners` | 다른 소유자 조회 → 404 |
| 3 | `confirms participants (uploader, exclude, rename) and recomputes stats` | 업로더 지정·1명 제외·이름 변경·제목 → 유효 2명, 표시 이름 "민수", 제목 "테스트 방"; 업로더를 제외 목록에 넣으면 400 |
| 4 | `creates a report (QUEUED) and rejects a second active one` | `FRIEND_ONE`/`CASUAL`/질문 → `QUEUED`, `seq 1`; 두 번째 → 409 `REPORT_ALREADY_RUNNING` |
| 5 | `runs the pipeline with the fake LLM and produces a full report` | `runReport` → `"done"`, `SUCCEEDED`, 헤드라인, 참여자 2(업로더 "민수"), 점수 5, 제안 3, 어워드 ≥3, 근거 텍스트·이름 채움, `answer.question`, `quality.mode SINGLE`, `costUsd ≥ 0`, `resolvedFocus FRIEND_ONE`, `llm_call_log`에 `SYNTHESIS OK` |
| 6 | `re-running a succeeded report is skipped (ownership)` | 재실행 → `"skipped"` |
| 7 | `fails with retryable error, then retries reusing checkpoints` | `seq 2`를 `rate_limit`로 실행 → `"failed"`, `LLM_UNAVAILABLE` retryable → `retryReport` → `QUEUED` → `ok`로 실행 → `SUCCEEDED`, `attemptCount 2`, 모든 참여자 `paragraphs ≥ 1` |
| 8 | `hallucinated ids are dropped and counted; non-korean output is repaired` | `hallucinate_ids` → `quality.evidence.dropped ≥ 1`; `hanja` → 본문에 한자 0, `quality.repaired true` |
| 9 | `cancels a queued report and the worker skips it` | 취소 → `CANCELED`; 워커 → `"skipped"`; 재취소 → 409 `INVALID_STATE` |
| 10 | `recovers stale RUNNING reports` | 클레임 후 `heartbeat_at`을 10분 전으로 → `recoverStaleReports` `requeued 1` → `QUEUED` → 실행 `"done"` |
| 11 | `shares and unshares a report` | enable → URL `/r/` 포함 → `getSharedReport` 성공 → disable → 404; 다른 소유자 enable → 404 |
| 12 | `expires raw text and blocks new reports afterwards` | `expires_at` 과거 → `expireRawConversations` 1 → `rawAvailable false`, `RAW_EXPIRED`; 기존 보고서 열림; 새 생성 → 409 `RAW_EXPIRED` |
| 13 | `deletes everything with cascade` | 삭제 → 404, `report`·`report_stage_result` 잔존 0 |
docs/18 §11-22가 인용한 "11 §3-11 삭제"는 이 표의 **13번**이다. 체크포인트 재사용(#7)은 Fake 호출 카운트를 직접 세지는 않는다(`llm_call_log.status='CACHED'` 검증 미구현).
**미구현 시나리오**(이전 계획 대비): 단톡 8명 제외·병합, **동시 생성 경쟁**(동시 POST 2개 → 하나 409), RUNNING 중 취소 시 `JobLostError`, 소유자 격리 보고서 조회, 에러 포맷 바디(`{code,message,fieldErrors}`) 자체 검증, 레이트리밋 429(`.env.test` 한도 1000), 삭제 후 `llm_call_log.report_id NULL`·공유 토큰 404, 보고서 단위 삭제(통합에는 없음 — 스모크 5b가 HTTP로 409/204/404를 검증), 업로더 미선택 경로, HTTP 라우트 레벨 테스트(스모크만).

## 4. 계약 테스트 (Anthropic 응답 형태) — **미구현**
`AnthropicLlmClient`(04 §4.3)의 분기는 코드 리뷰로만 확인된 상태. 작성 시 케이스: 정상 `parsed_output` 매핑 · `stop_reason max_tokens` → `max_tokens×1.5` 재호출 1회(요청 바디 검증) → 재차면 `LLM_MAX_TOKENS` · `refusal` → 폴백 모델 1회 → `LLM_REFUSED` · 429 → 2s/4s/8s 대기 후 3회 시도 → `LLM_UNAVAILABLE`(가짜 `sleep` 주입 가능: `AnthropicClientOptions.sleep`) · 400 → `LLM_BAD_REQUEST` 재시도 0회 · 요청 바디에 `system[0].cache_control`, `output_config.format`·`effort` 존재, `temperature` 부재. 도구 후보: nock 또는 `baseUrl` 옵션으로 로컬 가짜 서버.

## 5. 품질 평가(eval) — `scripts/eval.ts` (`pnpm eval [파일…]`)
- 입력: 인자로 준 내보내기 파일들, 없으면 기본 3종 `docs/fixtures/android_ko_basic.txt` · `ios_dotted_24h.txt` · `group_30people.txt`. 참여자는 봇 제외 등장 순 `p1…`, **2인이면 첫 참여자를 업로더로** 가정.
- 모델: `LLM_PROVIDER`(기본 `fake` → `FakeLlmClient("ok")`; `anthropic`이면 `ANTHROPIC_API_KEY` 필수, 실제 호출·비용 발생), `LLM_SYNTHESIS_MODEL`(기본 `claude-opus-5-5`), `LLM_FALLBACK_MODEL`, `LLM_CALL_TIMEOUT_MS`, `LLM_MAX_COST_USD`. 옵션 `EVAL_TONE`(기본 CASUAL), `EVAL_FOCUS`(기본 AUTO), `EVAL_QUESTION`, `PERSONA_NAME`.
- 처리: 파싱 → 통계·prior·사실 → 전사 → `makePlan` — **단일 패스만 지원**(청크 플랜이면 "워커로 실행하세요" 안내 후 건너뜀) → `SYNTHESIS` 1회(`maxTokens 16000`, `effort high`, 점수 on) → `validateDraft` → `enforceFinal` → 재검증 → `assembleReport`(REPAIR 호출은 하지 않음).
- 출력: 표준 출력 요약 + `$TMPDIR/ggai-eval/<파일>.json`(`summary`, `draft`, `validation{violations, metrics}`, `content`). `summary`: 모델·지연·토큰·비용, 헤드라인과 글자 수, 위반 종류별 개수, 근거 지표(total/dropped/lowFindings/unverifiedNumbers), 섹션 개수(발견·어워드·순간·점수·표현·농담·바뀐 주 유무), **화법 수치**(평균 문장 길이, 상담사 어휘 적중(`전반적으로|긍정적인|소통이|성향|노력이 필요|관계는 … 보입니다`), 재고 라벨 적중(`분위기 메이커|에너지|바이브|리더십|소통왕`), 한자 유무, 헤드라인 이모지 유무, 떡볶이 횟수).
- 미구현(계획 유지): 가상 대화 6종 세트(`A 균형 연애` · `B 일방(업로더가 더 달림)` · `C 일방(상대가 더 달림)` · `D 친구 티키타카` · `E 단톡 8명` · `F 갈등→회복`), LLM 심사(`claude-haiku-5-5`: 방향성·발견 주제 중복·유머 장치 ≥3종·숫자 직격 ≥2·콜백 ≥1, 1~5점), 결과 누적 비교(`eval/results/{date}.json`), 1회 비용 상한($15) 가드. 재미 평가는 아직 사람이 `content`를 읽어 14 §6 체크를 채점한다.

## 6. 성능 테스트 — **미구현**
목표치(유지): 50MB(약 100만 줄) 파싱 < 20초, 30만 메시지 통계 < 3초, 전사 렌더 < 2초, 워커 힙 1GB 이내. 측정 스크립트 없음.

## 7. 보안 테스트
| 항목 | 상태 |
|---|---|
| zip `../` 경로 거절 | 구현(§2.1) |
| zip 비텍스트 엔트리 무시 | 구현 |
| 확장자 위장(`.docx`) 거절 | 구현(`UNSUPPORTED_FILE_TYPE`) |
| UTF-16 BOM / 디코딩 불가 | 구현 |
| zip 2,001 엔트리·압축률 100배 거절 | 미구현 |
| 로그에 픽스처 본문·이름 0건 | 미구현(콘솔 수집기 없음) |
| DB 평문 토큰 0건(해시 길이 64) | 미구현 |
| 소유자 격리 | 통합 #2, #11(enable) |

## 8. E2E 스모크·수동 체크리스트
### 8.1 `scripts/smoke.sh` (`pnpm smoke`, web·worker 기동 상태, `LLM_PROVIDER=fake` 권장)
1. `POST /api/v1/conversations`(픽스처 `docs/fixtures/android_ko_basic.txt`, `focus=FRIEND_ONE`) → 201, 응답 최상위 `signal.grade`가 `EXCELLENT|GOOD|FAIR|WEAK`인지 확인(없으면 실패), 쿠키 jar 저장, 메시지 수·신호 라벨 출력
2. confirm: 업로더 = 첫 참여자, `isBot` 참여자 전부 제외, 제목 "스모크 테스트" → 200
3. `POST …/reports`(`FRIEND_ONE`/`CASUAL`/질문) → 202
4. 폴링 최대 60회×2초, `SUCCEEDED`면 헤드라인·점수 수·발견 수·커버리지 출력; `FAILED|CANCELED`면 실패
5. 공유: enable → `GET /r/{token}` 200 → `GET /r/{token}/card.png` 200(바이트 수 출력) → disable → `GET /api/v1/shared/{token}` 404
5b. 보고서 단위 삭제: 두 번째 보고서 생성(202) → 대기 중 `DELETE /api/v1/reports/{id}` **409** → `POST …/cancel` → `DELETE` **204** → `GET /api/v1/reports/{id}` 404 → 첫 보고서 `GET …/reports/{seq}` 200(생존 확인)
6. 페이지 200 확인: `/`, `/setup`, `/guide/export`, `/c/{id}`, `/c/{id}/story`, `/c/{id}/reports/{seq}`
7. `KEEP=1`이 아니면 `DELETE /api/v1/conversations/{id}` 204 → 재조회 404; `KEEP=1`이면 대화 ID·seq·쿠키 jar 경로 출력(스크린샷 스크립트 입력)
### 8.2 `scripts/screenshots.cjs`
쿠키 jar에서 `gg_owner`를 읽어 Playwright 컨텍스트에 심고 9장 저장: `01-landing-mobile`, `01-landing-desktop`, `02-setup-step1`, `03-story-1/2/3/7`(다음 버튼 클릭), `04-report`, `05-dashboard`.
### 8.3 수동 (릴리즈 전, 미실시)
- 실제 기기 내보내기 파일 각 1개(Android/iPhone/PC)로 업로드 — 본인·가족 대화만, 테스트 후 삭제.
- **모바일 브라우저 업로드**(iOS Safari·Android Chrome에서 "눌러서 올리기" → 파일 앱에서 `.txt`/`.zip` 선택, docs/18 P0-6) — 미실시.
- 모바일에서 보고서·공유 카드 스크린샷 가독성, 공유 링크를 쿠키 없는 브라우저에서 열어 소유자 기능 미노출 확인(스모크는 curl 200만 확인).
- 실제 모델(`LLM_PROVIDER=anthropic`)로 보고서 1건 생성, `llm_call_log.cache_read_tokens > 0`(두 번째 청크부터) 확인.
