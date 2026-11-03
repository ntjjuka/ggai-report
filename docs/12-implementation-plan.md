# 12. 구현 계획 → 진척 현황

> 2026-11-03 Node 구현 기준으로 갱신 (docs/18 P0-9). 원래 8스텝(Spring 기준) 계획을 **완료 상태 진척 표**로 바꿨다. 산출물 열은 실제 파일 경로다. 남은 일은 §11(백로그, docs/18 §12 참조)과 §12(문서 동기화 규칙)로 옮겼다.

## 0~7. 스텝별 진척 표
| 스텝 | 산출물(실제 파일) | 검증 | 상태 |
|---|---|---|---|
| **0 저장소·빌드 스캐폴드** | `package.json`(pnpm 10.28, 스크립트 `dev/build/start/lint/typecheck/test/test:watch/db:migrate/worker/smoke/eval`), `tsconfig.json`(strict, `@/*`), `next.config.ts`(standalone, `serverExternalPackages`, robots·캐시 헤더), `eslint.config.mjs`, `vitest.config.mts`, `.env.example`, `docker-compose.yml`(postgres·worker·web), `Dockerfile`(web/worker 타깃), `.dockerignore`, `db/migrations/0001_init.sql`, `src/server/migrate.ts`, `src/server/config.ts`(zod 환경변수) | `pnpm install`, `pnpm typecheck`, `docker compose up --build` 후 워커가 마이그레이션 적용 | 완료 |
| **1 파서** | `src/lib/parser/{types,patterns,kakaoParser,csv,encoding,zip,index}.ts` — 포맷 5종 상태 머신, 12시간제, 멀티라인, 시스템/미디어 분류, 봇 발신자(`isBotSender`), CP949·UTF-16 폴백, zip 안전 규칙, 분할 파일 병합·중복 제거, 한도·에러 코드 | `tests/parser.test.ts`(골든 12종 + 규칙 6) | 완료 |
| **2 통계 · Tier 0** | `src/lib/stats/{types,computeStats,priors,facts,time,index}.ts`(ChatStats v1, 세션·답장·히트맵·월별·fun facts·칼답률·호칭·말버릇·균형, 점수 prior 3세트, 숫자 사실 문장), `src/lib/tier0/{story,buildTier0,badges,awards,templates,index}.ts`(스토리 7장·신호 등급·뱃지 20·어워드·템플릿) | `tests/stats.test.ts`(5) | 완료 |
| **3 DB·서비스·업로드 API** | `src/server/{schema,db,crypto,owner,http,errors,ratelimit}.ts`, `src/server/services/{conversations,participants}.ts`, `src/app/api/v1/conversations/**/route.ts`(업로드·상세·확인·통계·삭제) | 통합 #1~#3, 스모크 1~2 | 완료 |
| **4 보고서 도메인·워커 (Fake LLM)** | `src/server/services/reports.ts`(상태 머신 CAS, 공유, 보고서 삭제, 체크포인트, stale 복구, 정리), `src/server/queue.ts`(pg-boss), `src/worker/{index,pipeline}.ts`, `src/lib/report/{schema,transcript,planner,validator,assembler,moods}.ts`, `src/lib/llm/fake.ts`, `src/app/api/v1/reports/**/route.ts`, `shared/[token]/route.ts` | 통합 #4~#13, `tests/report.test.ts` | 완료 |
| **5 LLM 통합 (Anthropic)** | `src/lib/llm/{client,anthropic,cost,prompts,index}.ts`(zod 구조화 출력, 캐시 1h, 재시도·폴백·max_tokens 처리, 단가표, 시스템/청크/종합/수리 프롬프트 + `FOCUS_GUIDE`), `src/server/llm.ts` | `tests/report.test.ts prompts`; 실모델 확인은 `LLM_PROVIDER=anthropic pnpm eval` 또는 `pnpm smoke`(수동) | 완료(코드). 계약 테스트는 미구현(11 §4), 품질 평가는 `pnpm eval`(11 §5) |
| **6 웹 UI** | `src/app/{layout,page,not-found}.tsx`, `setup/page.tsx` + `components/setup/Wizard.tsx`(7단계), `guide/export`, `privacy`, `terms`, `c/[id]/page.tsx`, `c/[id]/story/page.tsx` + `components/story/StoryViewer.tsx`, `c/[id]/reports/[seq]/page.tsx` + `components/report/{ReportView,ReportStatus}.tsx`, `r/[token]/page.tsx`, `r/[token]/card.png/route.tsx`, `components/{api,ui}.tsx`, `globals.css`, `public/fonts/*` | 스모크 6(페이지 200), `scripts/screenshots.cjs` | 완료(다크 모드·Lighthouse 미실시) |
| **7 운영·마무리** | `Dockerfile`(non-root)·`docker-compose.yml`, `README.md`(실행·환경변수·구조), `scripts/smoke.sh`(보고서 단위 삭제 5b 포함), `scripts/eval.ts`(품질 평가, 11 §5), 워커 유지보수 타이머(stale 60s · 원문 만료 10m · 체크포인트 정리 1h) | `docker compose up` → `pnpm smoke`, `pnpm eval` | 완료. **미완**: 구조화 로그(JSON)·메트릭·헬스체크 엔드포인트 |

구현 순서는 계획과 달리 UI·Docker가 스텝 3~5와 병행됐지만(18 §11-24), 2026-11-03 기준 전 스텝의 DoD 중 테스트 가능한 항목은 모두 녹색이다. 02 §6 수용 기준 대비 상태는 02 §6 참조.

## 8. 핵심 시그니처 (실제 TypeScript, 구현자가 참조할 진입점)
```ts
// src/lib/parser
parseUploads(files: NamedBytes[], limits?: ParseLimits): ParsedChat          // 업로드 진입점(디코딩+파싱)
decodeUploads(files: NamedBytes[]): { texts: NamedText[]; encodingFallback }  // 원문 정본(암호화 대상)
parseTexts(files: NamedText[], limits?, encodingFallback?): ParsedChat        // 재파싱(결정적 index)
isBotSender(name: string): boolean

// src/lib/stats
computeStats(messages: Message[], map: ParticipantMap, uploaderId: string | null): ChatStats
pickScoreSet(participantCount: number, focus: string): "PAIR" | "GROUP" | "WORK"
computePriors(stats, set): ScorePrior[]            renderStatsFacts(stats, messages, priors): StatsFact[]

// src/lib/tier0
buildTier0(stats, messages, seedKey): Tier0Report  signalInfo(stats): { grade, label, reasons }

// src/lib/report
buildTranscript(eff: EffectiveMessage[], participants): TranscriptMessage[]   buildEvidenceIndex(transcript)
makePlan(transcript, cfg: PlanConfig): Plan                                   // SINGLE | CHUNKED, 비용·커버리지
validateDraft(draft: ReportDraft, ctx: ValidationContext): ValidationResult  applyPatches(draft, patches)  enforceFinal(draft, violations)
assembleReport(draft, ctx: AssembleContext): ReportContent

// src/lib/llm
interface LlmClient { provider; generateJson<T>(req: StageRequest<T>): Promise<StageResponse<T>>; countTokens(model, system, user) }
buildSystemPrompt({ name })   buildChunkUserPrompt(args)   buildSynthesisUserPrompt(args)   buildRepairUserPrompt(args)

// src/server/services
uploadConversation(input): Promise<{ detail: ConversationDetail; reused }>   confirmParticipants(id, ownerHash, cmd)   deleteConversation(id, ownerHash)
createReport(conversationId, ownerHash, { focus, focusQuestion }): Promise<ReportView>
cancelReport / retryReport / enableShare / disableShare / deleteReport / getSharedReport
claimReport / heartbeat / markSucceeded / markFailed / recoverStaleReports / cleanupStageResults   // 워커 전용

// src/worker
runReport(reportId: string, deps: { llm: LlmClient; now?: () => number }): Promise<"done" | "skipped" | "failed">
```

## 9. 리스크와 대응 (갱신)
| 리스크 | 대응(현재) |
|---|---|
| 실제 내보내기 포맷 변형 | 상태 머신이 미매치 줄을 `ORPHAN_LINES`·`UNKNOWN_SYSTEM_LINES` 경고로 남기고 API `warnings`로 노출. 패턴 추가 시 03 갱신 + 픽스처·`expected.json` 추가 |
| SDK 버전 차이(`output_config`, `zodOutputFormat`) | `@anthropic-ai/sdk ^1.4.0` 고정 범위. 업그레이드는 `pnpm typecheck` + 실모델 스모크 1회 |
| 보고서 재미 부족 | `pnpm eval`(결정적 지표 + 화법 수치, 11 §5)로 프롬프트 변경마다 측정. LLM 심사·가상 대화 6종 세트는 미구현이라 "재미" 자체는 사람이 `content`를 읽어 14 §6으로 채점 |
| 비용 폭주 | PLAN 상한(`LLM_MAX_COST_USD`) + 소유자 일일 10건 + `llm_call_log.cost_usd`. 알람은 없음 |
| 긴 생성 시간 이탈 | 생성 직후 Tier 0 스토리 7장을 대기 콘텐츠로(09 §5.5) + ETA 카피. 쿠키 분실 시 복귀 불가는 미해결(P0-1) |
| 공유 URL이 다른 인스턴스에서 안 보임 | 토큰 원문이 프로세스 메모리 캐시(04 §5). 다중 web 배포 전 "enable 응답에서만 URL 제공" UX를 유지하거나 토큰을 암호화 저장으로 전환 |
| 설정 중간 이탈 | 위저드 진행 상태 서버 저장 없음. `?c=`로 4단계 복귀만 가능 |

## 10. 로컬 실행 절차 (README와 동일)
```bash
# Docker 전체(web + worker + postgres)
cp .env.example .env            # APP_CRYPTO_KEY(아래 명령으로 생성)·ANTHROPIC_API_KEY 채움. LLM 없이: LLM_PROVIDER=fake
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
docker compose up --build       # 워커가 기동 시 마이그레이션 적용, http://localhost:3000

# 개발 실행(Docker 없이, PostgreSQL 16이 떠 있어야 함)
pnpm install
pnpm db:migrate                 # .env의 DATABASE_URL
pnpm dev                        # web
pnpm worker                     # worker (tsx)

# 테스트·스모크
pnpm test                       # 단위 + 통합(.env.test: 127.0.0.1:5433/ggai_test, LLM_PROVIDER=fake)
pnpm smoke                      # 서버·워커 기동 상태에서 E2E (BASE_URL, KEEP=1)
pnpm eval [파일…]               # 품질 평가(기본 fake; LLM_PROVIDER=anthropic 이면 실제 호출·비용 발생, 결과 $TMPDIR/ggai-eval/*.json)
node scripts/screenshots.cjs http://localhost:3000 <cookie-jar> <conversationId> <seq> ./shots   # Playwright 전역 설치 필요
pnpm lint && pnpm typecheck
```

## 11. 남은 백로그 — docs/18 §12 참조 (여기서는 상태만)
| 구분 | 항목 | 상태 |
|---|---|---|
| **P0 미결(사용자 결정 대기)** | 이메일 6자리 인증 + 완료/실패 메일 + 재인증 복귀("내 보고서") — docs/18 P0-1 | **미구현**. 13 ADR-08에서 결정 대기(00·13 문서는 별도 갱신) |
| P0 완료 | 위저드(P0-2 일부: 이메일 단계 제외) · 유형 6종+AUTO·유형 지침(P0-3) · 업로더 선택(P0-4) · `signal`(P0-5) · 가이드 폰 경로(P0-6) · 신뢰 시트·`/privacy`(P0-7) · 보고서 단위 삭제(P0-8) · 문서 정합화 1차(P0-9, 이 문서 세트) | 완료 |
| P1 | 보고서 체인(`parent_report_id`, "하나 더 묻기")·슬라이딩 원문 만료(P1-1) · 봇 탐지 휴리스틱(P1-2: 이름 규칙은 구현, 발화 패턴 기반은 미구현) · 이메일 인바운드(P1-3) · OG/공유 강화(P1-4: OG 이미지·`card.png`는 구현, "나도 이 방 올리기"·만료는 미구현) · 재진입 CTA·6항목 기본 노출(P1-5: 섹션은 구현, 부가 섹션 접힘·뱃지/어워드 통합은 미구현) · `/faq`·`/support`·완료 메일 문구(P1-6) · confirm `title`·`share%`(P1-7: 구현) · `report.language` 변수화(P1-8: 컬럼만) · 재생성 한도 재설계·메트릭(P1-9) · 14 §2 UI 보이스(P1-10: 반영) · 유형별 랜딩(P1-11) | 표기대로 |
| P2 | 결제·`entitlement`·미리보기 게이팅(P2-1) · 영어 리포트(P2-2) · Personal read(P2-3) · 두 번째 페르소나(P2-4) · WhatsApp/LINE 파서(P2-5) · 크리에이터·후기·사칭 고지(P2-6) · Tier 0 포지셔닝(P2-7) | 미구현 |
| 테스트·운영 | 계약 테스트(11 §4) · eval 확장(가상 대화 6종·LLM 심사·결과 누적, 11 §5) · 성능 테스트(11 §6) · 로그 PII 자동 검사 · 구조화 로그·메트릭·헬스체크 · 의존성 스캔 · 키 회전 재암호화 | 미구현 |

## 12. 문서 동기화 규칙 (코드가 정본)
- **코드 변경 PR은 같은 PR에서 문서를 갱신한다**: 요구사항·흐름이 바뀌면 `02`, API 형태·에러 코드가 바뀌면 `06`, 화면·카피·단계가 바뀌면 `09`. 세 문서는 코드와 함께 리뷰 대상이다(18 §11-24).
- 추가 규칙: DDL·마이그레이션 → `05 §3`(SQL 그대로 복사) + `src/server/schema.ts`; 환경변수·큐·워커 루프 → `04 §4`; `ReportContent`/zod 스키마·섹션 순서 → `07 §2~§4` + `09 §3`; 검증 규칙 → `07 §6` + `08 §8`; 프롬프트 본문(`07 §5`)과 화법(`14`)은 담당자 관리 영역이라 코드(`prompts.ts`) 변경 시 해당 담당자에게 알린다.
- 각 문서 머리의 `> YYYY-MM-DD … 기준으로 갱신` 줄을 갱신 날짜로 바꾼다. 수치(한도·기간·임계값·모델명)는 코드에서 복사하고, 확인하지 못한 것은 "미확인"으로 쓴다.
- 미구현 기능은 "v2"라고 쓰지 않고 **미구현/미결**로 쓰고 docs/18 §12의 ID(P0-1 …)를 단다.
