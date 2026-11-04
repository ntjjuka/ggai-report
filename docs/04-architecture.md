# 04. 아키텍처

> 2026-11-03 Node 구현 기준으로 갱신 (docs/18 P0-9). 이 문서는 **코드가 정본**이다 — 수치·이름은 `package.json`, `src/server/*`, `src/worker/*`, `Dockerfile`, `docker-compose.yml`에서 그대로 옮겼다. Spring/Thymeleaf 기술 서술은 전부 제거했다(이전 결정 경위는 13 ADR-01, 15 §A).

## 1. 기술 스택 (구현 완료)
| 영역 | 선택 (버전은 `package.json`) | 메모 |
|---|---|---|
| 런타임/언어 | Node 22 (`node:22-alpine`), TypeScript `strict` (`tsconfig.json`), pnpm `10.28.0` | 단일 저장소·단일 빌드 |
| 웹 | **Next.js 16.4.4 App Router** + React 19.3.0, `output: "standalone"` | 페이지와 `src/app/api/v1/**/route.ts` Route Handler가 한 앱. 모든 페이지 동적 렌더(`force-dynamic`), 빌드 시 DB·키 불필요 |
| 스타일 | Tailwind v4 (`@tailwindcss/turbopack` 로더), 자체 호스팅 Pretendard(`public/fonts`, OFL) | 외부 CDN 의존 0 |
| DB / ORM | PostgreSQL 16 (`postgres:16-alpine`) + **drizzle-orm `^0.45.4` (node-postgres)** + `pg ^8.23.1` | 마이그레이션은 **SQL 파일이 정본**(`db/migrations/*.sql`, 05 §6). drizzle 스키마(`src/server/schema.ts`)는 DDL과 1:1 수동 동기 |
| 큐 | **pg-boss `^12.38.0`** (스키마 `pgboss`) | Redis 없음. §4.1 |
| LLM | `@anthropic-ai/sdk ^1.4.0` + `zodOutputFormat`(구조화 출력), `zod ^4.6.7` | 요청 DTO·LLM 출력·DB JSON 타입을 zod/TS 타입 하나로 공유 |
| 파서 보조 | `fflate`(zip), `iconv-lite`(CP949) | 03 문서 |
| 워커 실행 | `tsx` (TypeScript 직접 실행, `pnpm worker` / 컨테이너 `worker` 타깃) | 트랜스파일 빌드 없음 |
| 테스트 | **vitest `^5.1.0`** (+ `@vitest/coverage-v8`), 통합은 실제 PostgreSQL `ggai_test` | 11 문서. Playwright는 스크린샷 스크립트(`scripts/screenshots.cjs`)에만, 의존성에 없음(전역 설치 전제) |
| 린트 | eslint 9 + `eslint-config-next` | `eslint-plugin-boundaries` 같은 경계 강제 도구는 **미도입**(§3 의존 규칙은 관례) |
| 관측 | `console.*` 로그만 | 구조화 로거·메트릭(02 FR-O3)·헬스 엔드포인트 **미구현** |
| 배포 | Docker 3 컨테이너(`web`·`worker`·`postgres`) — `docker-compose.yml` | §5 |

## 2. 전체 구성도와 요청 흐름
```
[브라우저] ──HTTPS──> [web: Next.js standalone, :3000]           [postgres:16]
   │ ① POST /api/v1/conversations (multipart)   ──> conversation·participant·conversation_stats INSERT (원문 암호화, tier0_json)
   │ ② POST …/participants/confirm              ──> participant UPDATE + stats·tier0 재계산(원문 복호화)
   │ ③ POST …/reports                           ──> report INSERT(QUEUED) → 커밋 → pg-boss send(singletonKey=conversationId)
   │ ④ GET  …/reports/{seq} 3초 폴링 (Retry-After: 3)
   └──────────────────────────────────────────────────────────────────┐
                                                                      ▼
[worker: tsx src/worker/index.ts] boss.work("report-generate") ──> runReport(reportId)
   claim(QUEUED→RUNNING, attempt+1) → LOAD → STATS → RENDER → PLAN → CHUNK×n → SYNTHESIS → VALIDATE(+REPAIR 1회) → ASSEMBLE → markSucceeded
   유지보수 타이머: stale 복구 60초 · 원문 만료 10분 · 체크포인트 정리 1시간
                                                                      │
                                                                      ▼
                                                             [Anthropic Messages API]  (LLM_PROVIDER=fake 면 FakeLlmClient)
```

### 2.1 업로드 (`src/app/api/v1/conversations/route.ts` → `services/conversations.ts uploadConversation`)
1. 소유자 쿠키 `gg_owner`가 없으면 새 토큰을 만들고 응답에 심는다(`ownerForUpload`/`jsonWithOwner`, §4.6).
2. IP 해시 기준 레이트리밋(`assertUploadAllowed`, 시간당 `LIMIT_UPLOADS_PER_IP_PER_HOUR`=10) → 합계 바이트 > `UPLOAD_MAX_BYTES`(50MB)면 `FILE_TOO_LARGE`(413) → 파일 수 1~20 검사.
3. `decodeUploads`(zip 추출·인코딩 판별) → 디코딩된 `NamedText[]`를 JSON으로 직렬화한 것이 **원문 정본**. `raw_sha256 = sha256(그 JSON)`. 같은 소유자 + 같은 해시가 있으면 기존 대화 상세를 `200 reused:true`로 반환.
4. `parseTexts`(03) → 참여자 행 생성(`is_bot = isBotSender(rawName)`) → `buildParticipantMap`(봇 제외) → `computeStats`(08 §3) → `buildTier0`(통계 스토리 7장·신호 등급) → `suggestMerges`(1:1 이름 3~8개일 때만 제안).
5. 한 트랜잭션에 `conversation`(원문 `encryptRaw`, `tier0_json`, `merge_suggestions`, `default_focus`, `expires_at = now + RAW_RETENTION_DAYS(7)일`) + `participant` + `conversation_stats` INSERT → `audit("UPLOAD")` → `201` 대화 상세(06 §1).

### 2.2 참여자 확인 (`confirmParticipants`)
검증(필드 오류는 400 `VALIDATION_FAILED` + `fieldErrors`): 참여자 ID 존재, 자기 병합 금지, 병합 체인(`MERGE_CHAIN`) 금지, 업로더는 제외·병합 불가, 표시 이름 1~100자. 유효 참여자 < 2 → 409 `NOT_ENOUGH_PARTICIPANTS`. 원문이 남아 있으면 복호화·재파싱해 `stats_json`·`tier0_json`을 재계산(업로더 기준 `balance` 포함), 트랜잭션으로 참여자·대화(`uploader_participant_id`, `participants_confirmed_at`, `title`)·통계를 갱신한다. **업로더는 nullable**(모든 유형에서 선택, docs/18 P0-4 결정).

### 2.3 보고서 생성 (`services/reports.ts createReport`)
1. 소유자 일일 상한(`assertReportAllowed`, `LIMIT_REPORTS_PER_OWNER_PER_DAY`=10, `audit_event` 카운트).
2. 트랜잭션: `SELECT conversation … FOR UPDATE`(소유자 조건 포함, 없으면 404) → 원문 없음/`RAW_EXPIRED` → 409 `RAW_EXPIRED` → 참여자 맵에서 **스냅샷**(`participant_snapshot`: id·name·rawNames·isUploader) 생성, 2명 미만 → 409 `NOT_ENOUGH_PARTICIPANTS` → `QUEUED|RUNNING` 보고서 존재 → 409 `REPORT_ALREADY_RUNNING` → `seq = coalesce(max(seq),0)+1` → INSERT(`status QUEUED`, `progress_stage 'QUEUED'`, `progress_message "{페르소나}가 줄 서 있어요. 곧 시작해요"`, `persona_name = PERSONA_NAME`).
3. 커밋 후 `audit("REPORT_CREATE")` → `enqueueReportJob`(pg-boss `send`, `singletonKey = conversationId`) → 반환된 `job_id` 저장. 투입 실패 시 `markFailed(QUEUE_ERROR)`(retryable).
4. 응답 `202` + `statusUrl`.

### 2.4 워커 파이프라인 (`src/worker/pipeline.ts runReport`) — 단계와 진행률
| 단계(`progress_stage`) | pct | 내용 |
|---|---|---|
| `QUEUED` | 0 | 생성·재시도·stale 재큐 시 |
| `LOAD` | 2 → 5 | `claimReport`(CAS `status='QUEUED'`, `attempt_count+1`, `heartbeat_at`, `started_at=coalesce`) 후 원문 복호화·재파싱, 스냅샷으로 참여자 맵 복원 |
| `STATS` | 10 | `computeStats`(스냅샷 반영) → `pickScoreSet`(WORK→WORK, 그 외 2인=PAIR/3인+=GROUP) → `computePriors` → `renderStatsFacts`(숫자 사실 문장). 2인 대화의 `balance`는 업로더 미지정이어도 첫 참여자를 기준으로 계산한다(`computeBalance` 폴백, ADR-16) — 업로드·confirm·파이프라인 세 경로가 같은 규칙을 쓴다 |
| `RENDER` | 15 | `toEffectiveMessages` → `buildTranscript`(ID `m{index}`, 마스킹, 토큰 추정) → `buildEvidenceIndex` |
| (PLAN) | - | `makePlan`: SINGLE(≤`LLM_SINGLE_PASS_MAX_TOKENS` 150k) / CHUNKED(월 버킷 ≤`LLM_CHUNK_MAX_TOKENS` 60k, 총량 >`LLM_MAX_TOTAL_TOKENS` 1.5M이면 문맥 창 샘플링), 비용 추정 > `LLM_MAX_COST_USD`(5)면 재샘플링 후 `COST_LIMIT_EXCEEDED`. 진행 메시지는 따로 없음 |
| `CHUNK` | 15 → 70 (선형) | 청크별 `CHUNK` 호출(동시 `WORKER_CHUNK_CONCURRENCY`=3). `LLM_REFUSED`·`LLM_BAD_REQUEST`는 즉시 실패, 그 외 청크 실패는 건너뜀. 성공 비율 < 0.6 → `INSUFFICIENT_COVERAGE`. 청크당 하이라이트 원문 ≤ 25개 보존 |
| `SYNTH` | 78 | `pickMood`(안전 신호 시 WARM 강제) → `SYNTHESIS` 호출(전사 전체 또는 청크 JSON + 하이라이트 원문) |
| `VALIDATE` | 92 | `validateDraft`(08 §8, 07 §6) → 위반이 있으면 `REPAIR` 1회(`applyPatches`) → `enforceFinal` → 재검증. `verdict.body` 비었거나 headline 없음 → `VALIDATION_FAILED` |
| (ASSEMBLE) | - | `assembleReport`(07 §3 `ReportContent` + `quality`) |
| `DONE` | 100 | `markSucceeded`(CAS) — `content_json`, `quality_json`, `resolved_focus`, `progress_message "보고 끝"` |
| `FAILED` | - | `markFailed(code)` — §4.7 표의 사용자 문구·retryable 저장 |

각 단계 전환은 `heartbeat(reportId, attempt, progress)` — `UPDATE … WHERE status='RUNNING' AND attempt_count=attempt`가 0행이면 `JobLostError`(취소·재클레임)로 조용히 종료(`"skipped"`). 08 §1의 단계 이름 중 `PLAN`·`ASSEMBLE`은 코드에서 별도 `progress_stage` 값이 아니고, `REPAIR`는 LLM 호출 로그의 stage 값으로만 존재한다.

### 2.5 폴링
`GET /api/v1/conversations/{id}/reports/{seq}`는 `QUEUED|RUNNING`이면 `Retry-After: 3`, 항상 `Cache-Control: no-store`. 보고서 페이지의 `WritingScreen`이 3초 간격으로 호출하고 상태가 바뀌면 `router.refresh()`로 서버 렌더 화면(완료/실패/취소)으로 교체한다(09 §5).

## 3. 모듈 구조 (`src/`)
```
src/lib/parser     카카오톡 내보내기 파서: types·patterns(정규식, isBotSender)·kakaoParser(상태 머신)·csv·encoding·zip      03
src/lib/stats      결정적 통계: types(ChatStats)·computeStats·priors(점수 세트/prior)·facts(숫자 사실)·time             08 §3
src/lib/tier0      LLM 없는 통계 리포트: story(7장·signalLevel)·buildTier0·badges(20종)·awards·templates               15 §B.4, 17
src/lib/report     schema(zod·ReportContent)·transcript(렌더·마스킹)·planner·validator·assembler·moods                 07, 08
src/lib/llm        client(인터페이스)·anthropic·fake·cost(단가표)·prompts(시스템/청크/종합/수리)                         07 §5·§7
src/server         config(zod env)·crypto·db(drizzle)·schema(테이블)·errors·http(withApi)·owner(쿠키)·queue(pg-boss)·ratelimit·llm(클라이언트 선택)·migrate
src/server/services conversations(업로드·확인·삭제·만료·원문 로드)·participants(맵·스냅샷·병합 제안)·reports(상태 머신·공유·삭제·체크포인트·복구)
src/worker         index(프로세스 엔트리·유지보수 타이머)·pipeline(runReport)
src/app            페이지(/, /setup, /guide/export, /privacy, /terms, /c/[id], /c/[id]/story, /c/[id]/reports/[seq], /r/[token], /r/[token]/card.png) + api/v1
src/components     api(fetch 헬퍼)·ui·setup/Wizard·report/{ReportStatus,ReportView}·story/StoryViewer
db/migrations      0001_init.sql (05 §3)        tests/  vitest (11)        scripts/  smoke.sh · screenshots.cjs · eval.ts(품질 평가, 11 §5)
```
의존 방향(관례, 도구로 강제하지 않음): `app → server → lib`, `worker → server·lib`. `lib/*`는 `server`·`app`을 import하지 않는다. Anthropic SDK import는 `src/lib/llm/anthropic.ts` 한 곳. `lib/tier0`·`lib/report`는 `lib/stats`에, `lib/report`는 `lib/tier0/badges`·`lib/llm/cost`에 의존한다.

## 4. 핵심 설계 포인트

### 4.1 비동기 큐 = pg-boss, 상태의 정본 = `report` 테이블
- 큐: `src/server/queue.ts`. `new PgBoss({ schema: "pgboss", supervise: role==="worker", schedule: false, max: worker 5 / web 2 })`. 큐 `report-generate`는 `createQueue({ policy: "stately", retryLimit: 0, expireInSeconds: WORKER_PIPELINE_TIMEOUT_MINUTES*60 + 300 })`(기본 1,800초). 투입은 `send(queue, {reportId}, { singletonKey: conversationId })` → "대화당 활성 잡 1개"를 pg-boss 정책 + DB 부분 유니크 인덱스 `uq_report_one_active`(05 §3)로 이중 방어. pg-boss 자체 재시도는 끄고(`retryLimit 0`) 재시도·복구는 아래 우리 로직만 쓴다.
- 소비: `src/worker/index.ts`가 `WORKER_CONCURRENCY`(2)개의 `boss.work(REPORT_QUEUE, { batchSize: 1, pollingIntervalSeconds: 2 }, …)` 핸들러를 등록하고 각 잡에 `runReport`를 실행한다.
- 소유권: 클레임·하트비트·성공 전이 모두 CAS(`status='RUNNING' AND attempt_count=?`). 영향 행 0 → `JobLostError`. 취소(`cancelReport`)는 상태를 즉시 `CANCELED`로 바꾸고 `boss.cancel(jobId)`를 시도하며, 이미 실행 중이면 워커가 다음 하트비트에서 중단한다.
- 유지보수 루프(`worker/index.ts`, `setInterval`):
  | 주기 | 함수 | 동작 |
  |---|---|---|
  | 60초 (+ 워커 기동 직후 bootstrap) | `recoverStaleReports` | ⓪ 워커가 SIGTERM을 받으면 처리 중이던 보고서를 **즉시** `QUEUED`로 되돌리고 재큐잉(`requeueRunning`) — 재배포 뒤 멈춤 없음 ① `RUNNING AND heartbeat_at < now - WORKER_STALE_MINUTES(3)분`(bootstrap은 60초) → 옛 pg-boss 잡을 **cancel+deleteJob으로 비운 뒤** `attempt_count < WORKER_MAX_ATTEMPTS(3)`면 `QUEUED`로 되돌리고 다시 enqueue, 아니면 `FAILED(STALE_TIMEOUT)` ② `QUEUED`인데 잡이 없거나 끝난 상태(2분 이상, bootstrap은 즉시) → 다시 enqueue. 파이프라인은 30초마다 하트비트를 써서 수 분짜리 LLM 호출 중에도 오탐되지 않는다. `createReport`도 enqueue가 null(싱글톤 충돌)이면 그 대화의 끝난 보고서가 남긴 잡을 비우고 한 번 더 시도한다 |
  | 10분 | `expireRawConversations` | `raw_cipher IS NOT NULL AND expires_at < now` → `raw_cipher=NULL, status='RAW_EXPIRED'` + `audit("RAW_EXPIRE")` |
  | 60분 | `cleanupStageResults` | `report_stage_result.created_at < now - STAGE_RESULT_RETENTION_HOURS(24)` 이고 보고서가 `SUCCEEDED`인 행 삭제 |
- 워커 시작 시 `MIGRATE_ON_START !== "false"`면 `runMigrations`(05 §6)를 먼저 적용한다.

### 4.2 트랜잭션 경계와 부수효과
- 업로드: 파싱·통계·Tier 0 계산은 트랜잭션 **밖**, `conversation + participant + conversation_stats` 저장만 한 트랜잭션.
- 보고서 생성: 한 트랜잭션에서 대화 행 `FOR UPDATE` → 활성 보고서 검사 → `seq` 채번 → INSERT. 유니크 `(conversation_id, seq)`와 `uq_report_one_active`가 2차 방어. 큐 투입은 **커밋 후**.
- 워커: 긴 트랜잭션을 열지 않는다. 체크포인트 저장(`saveStageResult`, `onConflictDoNothing`), 호출 로그(`logLlmCall`), 하트비트는 각각 단문 UPDATE/INSERT. LLM 호출 중 커넥션을 쥐지 않는다(`pg.Pool max 10`).
- 알림(완료/실패 이메일)은 **미구현** — 이메일 신원·전달 모델 자체가 사용자 결정 대기(13 ADR-08, docs/18 P0-1). 현재 복귀 수단은 소유자 쿠키 + 링크만이다.

### 4.3 외부 연동(Claude) 규칙 — `src/lib/llm/anthropic.ts`, `src/worker/pipeline.ts`
- 인터페이스 `LlmClient { provider; generateJson<T>(StageRequest<T>); countTokens() }`. 구현 2종: `AnthropicLlmClient`, `FakeLlmClient`(`LLM_PROVIDER=fake`, 시나리오는 `FAKE_LLM_SCENARIO`; 11 §3). 선택은 `src/server/llm.ts getLlmClient()`.
- 호출: `client.messages.parse({ model, max_tokens, system: [{type:"text", text, cache_control:{type:"ephemeral", ttl:"1h"}}], messages:[user], output_config: { format: zodOutputFormat(schema), effort } })`. 시스템 프롬프트는 바이트 고정(테스트로 보장)이라 캐시가 맞는다. `temperature` 등 샘플링 파라미터는 보내지 않는다.
- **토큰 절감(2026-11-03 추가, docs/19 1단계)**: ① 압축 전사(08 §4) ② 전사가 `LLM_CHUNK_LARGE_TOKENS`(기본 100만)를 넘으면 청크 추출 모델을 `LLM_CHUNK_MODEL_LARGE`(기본 Haiku 5.5, Sonnet의 1/20 단가)로 ③ 청크 추출·수리는 effort `low`, 종합만 `high` ④ 청크 결과 캐시 키를 **대화 단위**(`conversationId|CHUNK|systemHash|focus|participants|sha(text)|model`)로 바꿔 같은 대화의 다음 보고서는 청크 추출 비용이 0 — `report_stage_result`의 CHUNK 행은 `RAW_RETENTION_DAYS` 동안 보관 ⑤ 청크가 24개를 넘으면 종합 입력을 다이어트(`trimChunkForSynthesis`: 청크당 사건 4·하이라이트 4·키워드 6·로스트 3·갈등 2·계획 2, 요약 300자, 하이라이트 후보 총 160줄) ⑥ 모든 호출은 스트리밍 수신, 출력 한도 청크 32k·종합 64k.
- **JSON 모드(2026-11-03 추가)**: 구조화 출력은 서버가 JSON Schema를 문법으로 컴파일하는데, 종합 초안(ReportDraft) 스키마는 400 `The compiled grammar is too large`로 거부된다(실 배포에서 확인). 그래서 `SYNTHESIS`는 `output_config.format` 없이 `messages.create`로 보내고 스키마 JSON을 사용자 프롬프트 끝에 붙인 뒤 응답 텍스트의 JSON을 zod로 검증한다(실패 시 1회 재요청 후 `LLM_BAD_OUTPUT`). 다른 단계는 구조화 출력을 쓰다가 같은 400을 만나면 그 단계를 JSON 모드로 전환해 프로세스 안에서 기억한다. 환경변수 `LLM_JSON_MODE_STAGES`(기본 `SYNTHESIS`)로 처음부터 JSON 모드로 돌릴 단계를 지정한다.
- 재시도: SDK `maxRetries: 0`, 타임아웃 `LLM_CALL_TIMEOUT_MS`(600,000ms). 우리 재시도는 429/5xx/연결 오류·**스트림 수신 중 끊김(undici `terminated` 등 네트워크 계열)**에 **최대 3회 시도**, 대기 2s → 4s → 8s. 소진 시 `LLM_UNAVAILABLE`(retryable) → 파이프라인이 20초 뒤 자동 재큐잉(08 §10). 400/401/403 → `LLM_BAD_REQUEST`(비재시도).
- `stop_reason`: `refusal` → `LLM_FALLBACK_MODEL`로 1회 재호출(같은 모델이면 생략), 재차 refusal → `LLM_REFUSED`. `max_tokens` → `max_tokens × 1.5`(상한 32,000) 1회 → 재차 → `LLM_MAX_TOKENS`. `parsed_output`이 null → 1회 재호출 → `LLM_BAD_OUTPUT`.
- 멱등 체크포인트: `request_key = sha256("{reportId}|CHUNK|{chunkIndex}|{systemHash16}|{sha256(user)}|{model}")`(종합·수리는 `|SYNTHESIS|`·`|REPAIR|`, chunkIndex 없음). 호출 전 `report_stage_result`에 같은 키가 있으면 재사용하고 `llm_call_log.status='CACHED'`로 남긴다 → 재시도·재기동 시 비용 0.
- 상한: 보고서 전체 데드라인 `WORKER_PIPELINE_TIMEOUT_MINUTES`(25분)를 **각 호출 직전**에 검사 → `PIPELINE_TIMEOUT`. 비용 가드는 PLAN 단계에서 `estimateCostUsd`(단가표 `src/lib/llm/cost.ts`)로 추정 → `LLM_MAX_COST_USD` 초과 시 비율 샘플링(최소 10%) → 그래도 초과면 `COST_LIMIT_EXCEEDED`. 토큰 수는 **추정식**(`ceil(chars/1.6)+1`)을 쓴다 — `countTokens` API는 클라이언트에 구현돼 있으나 파이프라인이 호출하지 않는다(08 §4 서술과 다름, 비용 0 절약 목적의 설계 차이).
- 모델·파라미터(코드 상수): CHUNK `LLM_CHUNK_MODEL`(기본 `claude-sonnet-5-5`) `maxTokens 8000` `effort medium` · SYNTHESIS `LLM_SYNTHESIS_MODEL`(기본 `claude-opus-5-5`) `16000` `high` · REPAIR 종합 모델 `8000` `medium` · 폴백 `LLM_FALLBACK_MODEL`(기본 `claude-opus-4-8`). 단가표(USD/1M, 입력/출력/캐시읽기/캐시쓰기): opus-5-5 4/20/0.2/5 · opus-5·opus-4-8 5/25/0.5/6.25 · sonnet-5-5·sonnet-5 2/10/0.2/2.5 · haiku-5-5 0.1/0.5/0.01/0.125 · 미등록 모델은 5/25/0.5/6.25.
- 호출 로그 `llm_call_log`: stage, chunk_index(수리는 -2, 종합 -1), model, request_key, attempt, status(`OK|CACHED|RETRYABLE_ERROR|FATAL_ERROR|REFUSAL|MAX_TOKENS`), error_type, 토큰 4종, cost_usd, latency_ms. 본문은 남기지 않는다.

### 4.4 원문 보관과 결정성 — `src/server/crypto.ts`, `services/conversations.ts`
- 원문 = 디코딩된 `NamedText[]`의 JSON. `encryptRaw(plain, aad=conversationId)` = AES-256-GCM, 출력 `nonce(12B) || ciphertext || tag(16B)`. 키는 `APP_CRYPTO_KEY`(base64 32바이트, 길이 검증), `raw_key_id = APP_CRYPTO_KEY_ID`(기본 `k1`). 구 키로 복호화하는 회전 로직은 **미구현**(컬럼만 준비).
- 복호화는 세 곳만: 참여자 확인 재계산, 워커 `LOAD`, (만료 전) 재파싱. 결과는 메모리에만. 파서는 결정적이라 `index`가 보존되고, 통계·전사·근거 ID가 모두 `index`로 연결된다.
- 보고서 `content_json`에는 인용 텍스트가 **복사**되어 있으므로 원문 만료(`RAW_EXPIRED`) 뒤에도 보고서는 열리고, 새 보고서·재시도만 409 `RAW_EXPIRED`로 막힌다.

### 4.5 설정 — 환경변수 (`src/server/config.ts`의 zod 스키마가 정본, `.env.example` 참고)
| 키 | 기본값 | `.env.example` | 용도 |
|---|---|---|---|
| `DATABASE_URL` | (필수) | ✓ | pg·pg-boss·마이그레이션 공용 |
| `APP_BASE_URL` | `http://localhost:3000` | ✓ | 공유 URL `{base}/r/{token}` |
| `APP_CRYPTO_KEY` | (필수, base64 32B) | ✓ | 원문 암호화 키 |
| `APP_CRYPTO_KEY_ID` | `k1` | ✓ | `raw_key_id` |
| `PERSONA_NAME` | `까비서` | ✓ | 보고서 `persona_name`, 프롬프트, UI(페이지는 `process.env.PERSONA_NAME`을 직접 읽음) |
| `SCORES_ENABLED` | `"true"` | ✓ | `"false"`면 점수 섹션 비활성(`scoresEnabled`) |
| `LLM_PROVIDER` | `anthropic` | ✓ | `anthropic` / `fake` |
| `ANTHROPIC_API_KEY` | - | ✓ | 없으면 경고만 하고 SDK 기본 자격증명 탐색에 의존 |
| `LLM_CHUNK_MODEL` / `LLM_SYNTHESIS_MODEL` / `LLM_FALLBACK_MODEL` | `claude-sonnet-5-5` / `claude-opus-5-5` / `claude-opus-4-8` | ✓ | §4.3 |
| `LLM_SINGLE_PASS_MAX_TOKENS` / `LLM_CHUNK_MAX_TOKENS` / `LLM_MAX_TOTAL_TOKENS` | 150000 / 60000 / 1500000 | - | PLAN |
| `LLM_MAX_COST_USD` | 5 | ✓ | 비용 상한 |
| `LLM_CALL_TIMEOUT_MS` | 600000 | - | 호출당 타임아웃 |
| `LLM_PERSONA_EFFORT` | `high` | - | 장(章)·인물 갈래(`SYNTHESIS_SCENES`·`SYNTHESIS_PERSONA`)의 사고 수준. 코미디 설계라 기본 high |
| `LLM_SYNTH_SPLIT` | `on` | - | 종합을 세 갈래(장 → 인물 묶음 병렬 ∥ 판정)로(08 §7, 2026-11-04). `off`면 한 호출 |
| `LLM_SYNTH_STAGGER_MS` | 15000 | - | 판정 갈래 호출 지연 — 장 호출이 쓴 프롬프트 캐시(공유 문맥) 적중용 |
| `LLM_PERSONA_BATCH_SIZE` | 3 | - | 인물 묶음 호출 크기(텍스트 지분 상위 8명 기준, 나머지는 2배). 작을수록 카드가 촘촘하고 호출 수가 늘어난다 |
| `LLM_PERSONA_MAX_CALLS` | 6 | - | 인물 호출 수 상한. 넘으면 묶음을 키운다 |
| `UPLOAD_MAX_BYTES` / `UPLOAD_MAX_MESSAGES` / `UPLOAD_MIN_MESSAGES` / `UPLOAD_MAX_PARTICIPANTS` | 52428800 / 300000 / 30 / 60 | ✓ / - / ✓ / - | 03 §1.1 한도 |
| `RAW_RETENTION_DAYS` | 7 | ✓ | `expires_at` |
| `STAGE_RESULT_RETENTION_HOURS` | 24 | - | 체크포인트 보존 |
| `WORKER_CONCURRENCY` / `WORKER_CHUNK_CONCURRENCY` | 2 / 3 | ✓ / - | 동시 보고서 / 보고서 내 동시 청크 |
| `WORKER_STALE_MINUTES` / `WORKER_MAX_ATTEMPTS` / `WORKER_PIPELINE_TIMEOUT_MINUTES` | 3 / 3 / 25 | - | §4.1 |
| `LIMIT_UPLOADS_PER_IP_PER_HOUR` / `LIMIT_REPORTS_PER_OWNER_PER_DAY` | 10 / 10 | ✓ | §4.6 |
| `IP_HASH_SALT` | `ggai`(코드) · `change-me`(.env.example) | ✓ | IP 해시 솔트 |

config 밖에서 직접 읽는 값: `MIGRATE_ON_START`(워커, `"false"`가 아니면 적용), `FAKE_LLM_SCENARIO`(fake 시나리오, 11 §3), `NODE_ENV`(`production`일 때만 쿠키 `Secure`), `ANTHROPIC_AUTH_TOKEN`(키 없음 경고 억제 조건), 컨테이너의 `PORT`·`HOSTNAME`. 테스트 환경은 `.env.test`(`ggai_test` DB, 포트 5433, `LLM_PROVIDER=fake`, `UPLOAD_MIN_MESSAGES=1`, 한도 1000, `WORKER_STALE_MINUTES=3`).

### 4.6 소유자 식별 · HTTP 공통 · 레이트리밋
- 소유자: `src/server/owner.ts`. 쿠키 `gg_owner` = 32바이트 CSPRNG `base64url`(43자). 속성 `HttpOnly; SameSite=Lax; Path=/; Max-Age=1년; Secure(production)`. DB에는 `sha256(token)`만(`owner_token_hash`, `audit_event.owner_hash`). `readOwner`는 길이 32 미만 토큰을 무시한다. 쿠키 없이 소유자 리소스 접근 → 404(존재 노출 방지, `requireOwner`). 복구·다기기 수단은 없음(10 §3).
- 공통 래퍼 `withApi`(`src/server/http.ts`): `X-Request-Id` 수용/발급, 예외 → 06 §0 에러 표준. 클라이언트 IP는 `x-forwarded-for`(첫 값) → `x-real-ip` → `0.0.0.0` 순(리버스 프록시 뒤 배치 전제), `hashIp = sha256("{IP_HASH_SALT}|{ip}")`.
- 레이트리밋(`src/server/ratelimit.ts`): 별도 저장소 없이 `audit_event`를 센다. 업로드 = `UPLOAD` 이벤트 × 같은 `ip_hash` × 최근 1시간 ≥ 10 → 429 `RATE_LIMITED`, `Retry-After: 3600`. 보고서 = `REPORT_CREATE` × 같은 `owner_hash` × 최근 24시간 ≥ 10 → 429, `Retry-After: 86400`. 인덱스 `ix_audit_ip`, `ix_audit_owner`. 다중 web 인스턴스에서도 일관.

### 4.7 실패 코드 표 — `src/server/services/reports.ts ERROR_MESSAGES / RETRYABLE`
| `error_code` | retryable | 사용자 문구(`error_message`) | 발생 지점 |
|---|---|---|---|
| `LLM_UNAVAILABLE` | ✓ | 까비서가 잠깐 자리를 비웠어요. 다시 시도해 주세요 | 429/5xx/연결 오류 소진 |
| `LLM_BAD_REQUEST` | ✗ | 보고서 생성 요청에 문제가 있었어요. 운영팀이 확인 중이에요 | 400/401/403 |
| `LLM_REFUSED` | ✗ | 이 대화는 까비서가 분석하지 않기로 했어요 | refusal 2회 |
| `LLM_BAD_OUTPUT` | ✓ | 까비서가 보고서를 끝까지 쓰지 못했어요. 다시 시도해 주세요 | `parsed_output` null 2회 |
| `LLM_MAX_TOKENS` | ✓ | 보고서가 너무 길어져서 멈췄어요. 다시 시도해 주세요 | max_tokens 2회 |
| `INSUFFICIENT_COVERAGE` | ✓ | 대화를 충분히 읽지 못했어요. 다시 시도해 주세요 | 청크 성공률 < 60% |
| `COST_LIMIT_EXCEEDED` | ✗ | 대화가 너무 길어서 이번엔 못 읽었어요. 기간을 나눠 올려주세요 | PLAN |
| `PIPELINE_TIMEOUT` | ✓ | 생성 시간이 너무 길어져 중단했어요. 다시 시도해 주세요 | 25분 데드라인 |
| `STALE_TIMEOUT` | ✓ | 생성 중 연결이 끊겼어요. 다시 시도해 주세요 | stale 복구, attempt 소진 |
| `VALIDATION_FAILED` | ✓ | 보고서 검증을 통과하지 못했어요. 다시 시도해 주세요 | 판정 결손 |
| `RAW_EXPIRED` | ✗ | 원문 보관 기간이 지나 생성할 수 없어요 | (생성·재시도 요청 단계에서 409로 선차단) |
| `QUEUE_ERROR` | ✓ | 작업 대기열에 넣지 못했어요. 다시 시도해 주세요 | pg-boss send 실패 |
| `INTERNAL_ERROR` | ✓ | 문제가 생겼어요. 다시 시도해 주세요 | 분류 불가 예외(파서 `NO_MESSAGES` 등 미등록 코드는 이 문구로 표시) |
재시도(`POST /reports/{id}/retry`)는 `FAILED`이고 `attempt_count < WORKER_MAX_ATTEMPTS`이며 원문이 남아 있을 때만(06 §2). 재시도 시 체크포인트(`request_key`)가 같으면 LLM 재호출 없이 통과한다.

## 5. 배포 토폴로지 (MVP, `docker-compose.yml` · `Dockerfile`)
| 서비스 | 이미지/타깃 | 비고 |
|---|---|---|
| `postgres` | `postgres:16-alpine`, 볼륨 `pgdata`, healthcheck `pg_isready` | 사용자/DB `ggai`, 비밀번호 `${POSTGRES_PASSWORD:-ggai}` |
| `worker` | Dockerfile 타깃 `worker`: `deps` 스테이지 + `src`·`db`·`tsconfig.json`·`next.config.ts`·`public/fonts` 복사, non-root `app`, `CMD node_modules/.bin/tsx src/worker/index.ts` | `MIGRATE_ON_START=true` → 기동 시 마이그레이션. `.env` 전체 주입 |
| `web` | 타깃 `web`: `pnpm next build` 산출 `.next/standalone` + `.next/static` + `public`, non-root, `PORT=3000 HOSTNAME=0.0.0.0`, `CMD node server.js` | 포트 `${WEB_PORT:-3000}:3000`, `APP_BASE_URL` 주입, `depends_on: worker started` |
- 빌드 시 DB·키 불필요(모든 페이지 동적). `.dockerignore`가 `.env*`(예시 제외)·`docs`·`node_modules`를 제외한다.
- 수평 확장: web N개는 무상태다(2026-11-04부터 공유 토큰 원문도 DB에 암호화 보관 — 그 전엔 프로세스 메모리 캐시라 재시작·다른 인스턴스에서 `share.url`이 비었다, 13 ADR-27). worker M개는 pg-boss가 분배한다. Vercel 단독 배포는 장기 실행 워커 때문에 부적합.
- 헬스체크 엔드포인트·메트릭·백업 스케줄은 저장소에 없다(운영 과제). 원문은 암호화 상태로 백업되므로 키(`APP_CRYPTO_KEY`)는 DB와 분리해 보관해야 한다.
- 로컬 실행 절차는 12 §10(README와 동일).
