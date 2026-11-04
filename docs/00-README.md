# 까비서 (ggai-report) — 설계 문서 세트

카카오톡 대화 내보내기를 올리면 AI 페르소나 「까비서」(까다+비서, 반말)가 다 읽고 **솔직하고 웃긴, 근거 있는 보고서**를 써주는 서비스. "What Brandon Thinks"의 카카오톡·한국어 카피본.

> 2026-11-03: **구현 완료(Node.js)**. 정본은 코드(`src/`, `db/`)이고, 문서는 코드 기준으로 정합화했다(18 P0-9). 실행 방법은 저장소 루트 `README.md`.

## 구현 상태 (2026-11-03)
| 영역 | 상태 | 검증 |
|---|---|---|
| 파서(5포맷·zip·CP949)·통계·Tier 0 통계 스토리 7장 | 완료 | vitest `tests/parser.test.ts`, `tests/stats.test.ts` + 픽스처 13종 |
| DB(drizzle, `db/migrations/0001_init.sql`)·서비스·API·소유자 쿠키·레이트리밋 | 완료 | `tests/integration/flow.test.ts`(실 Postgres) |
| 워커 파이프라인·Anthropic/Fake LLM·검증기·어셈블러 | 완료 | `tests/report.test.ts`, 통합 테스트(Fake 시나리오 7종) |
| UI(랜딩·가이드·위저드 7단계·통계 스토리·대기/실패/보고서·공유·카드 PNG) | 완료 | `scripts/smoke.sh`(E2E), `scripts/screenshots.cjs` |
| Docker(web·worker·postgres) | 작성 완료 | 이 세션에서는 Docker 데몬이 없어 **이미지 빌드 미검증** |
| 실제 Claude 호출 품질(eval) | 미검증 | `LLM_PROVIDER=anthropic` 실호출·`scripts/eval.ts` 미작성 |
| 이메일 인증·완료 메일(18 P0-1) | **미구현·미결** | 13 ADR-08·Q4 — 사용자 결정 필요 |

## 읽는 순서
| 문서 | 내용 | 상태 |
|---|---|---|
| [01 조사](01-research-whatbrandonthinks.md) | 원 서비스 구조·보고서 형식·가격·톤, 경쟁/오픈소스, 반영 결론 | 완료(공식 페이지 직접 확인은 미완, 출처 등급 표기) |
| [02 요구사항](02-requirements.md) | 가정, 사용자 흐름(위저드), FR/NFR, 범위, 수용 기준 | Node 기준 갱신 |
| [03 파서 명세](03-kakao-export-format-spec.md) | 포맷 5종 정규식, 상태 머신, 시스템/미디어 분류, 인코딩·zip, 에러 코드, 픽스처 | 완료(구현 `src/lib/parser`) |
| [04 아키텍처](04-architecture.md) | Next.js web / worker / Postgres, pg-boss 큐, 파이프라인, 체크포인트·복구, 설정 키 | Node 기준 갱신 |
| [05 데이터 모델](05-data-model.md) | ERD, `0001_init.sql` DDL, 보존·삭제, 마이그레이션 규칙 | Node 기준 갱신 |
| [06 API](06-api-spec.md) | REST 엔드포인트 전수, 응답 형태, 에러 표준, 상태 전이 409, 페이지 경로 | Node 기준 갱신 |
| [07 보고서·프롬프트](07-report-schema-and-prompts.md) | 페르소나, 유머 장치, 뱃지, 섹션(공식 6항목 순서), zod 스키마, 프롬프트 전문, 검증 규칙, 모델 | 완료(실제 리포트 대조 보정 대기) |
| [08 파이프라인](08-analysis-pipeline.md) | 단계별 처리, 전사 렌더, 청킹·샘플링·비용, 검증·수리, 실패 매트릭스 | 완료(구현 `src/worker/pipeline.ts`) |
| [09 프론트/UX](09-frontend-ux.md) | 실제 라우트·위저드 단계·보고서 레이아웃·공유 카드·진행 카피 | Node 기준 갱신 |
| [10 보안·프라이버시](10-security-privacy.md) | 암호화, 쿠키·토큰, 인젝션 방어, PII 마스킹, 처리위탁·국외 이전 고지, 콘텐츠 안전 | Node 기준 갱신 |
| [11 테스트](11-test-plan.md) | vitest 단위/통합, 스모크 E2E, 스크린샷, 미구현 테스트 목록 | Node 기준 갱신 |
| [12 구현 계획](12-implementation-plan.md) | 진척 표(전 스텝 완료), 남은 백로그 링크, 문서 동기화 규칙 | Node 기준 갱신 |
| [13 결정·미결](13-decisions.md) | ADR 22개(Node 확정 포함), 사용자 확인 질문, 검증 상태 | 갱신 |
| [14 화법 가이드](14-voice-style-guide.md) | Brandon 화법 특징(근거 등급), 까비서 캐릭터 시트(기분·괴벽·서명), 문장 패턴, 섹션별 템플릿, 샘플 3종, 품질 체크, UI 보이스 | 완료(실제 리포트 대조 대기) |
| [15 스택·LLM 재검토](15-stack-and-llm-review.md) | Node vs Spring 비교(→ Node 결정), LLM 필요성, Tier 0 통계 리포트 설계, 매핑표 | 완료(결정 반영) |
| [16 화법 조사 부록](16-voice-research-addendum.md) | 별도 에이전트 조사: 공식 FAQ 목차 6항목, 유머 장치·프롬프트 규칙 후보, 반영 체크리스트 | 완료(07 §10·14 §8에 반영) |
| [17 원 서비스 실측](17-brandon-setup-flow-observed.md) | 사용자 스크린샷 기반 1차 증거: 위저드 7단계, 통계 스토리 7장, 대기 화면, 설계 결정 | 완료 |
| [18 갭 분석](18-gap-analysis.md) | 별도 에이전트 비판 리뷰: 사이트맵 복원, 항목별 차이, 내부 모순 28건, 백로그 P0 9·P1 11·P2 7 | 완료(P0 중 코드로 가능한 것 반영, P0-1 미결) |
| `fixtures/` | 파서 골든 테스트용 가상 대화 13종(Android/iOS 12h·24h/PC/영문/CSV/분할/CP949/엣지) + `*.expected.json` 기대값 | 13/13 작성·검증 |
| `tools/spec_parser_prototype.py` | 03 명세의 Python 참조 구현. 픽스처 검증·기대값 생성용(`python3 -I tools/spec_parser_prototype.py fixtures --write-expected`). **TypeScript 구현(`src/lib/parser`)이 정본** | 완료 |

## 용어
- **대화(Conversation)**: 업로드 1건(파일 N개 병합). **보고서(Report)**: 대화에 대한 생성물, `seq`로 번호.
- **업로더**: 대화 참여자 중 사용자 본인(선택 지정). **스냅샷**: 보고서 생성 시점의 참여자 매핑.
- **접지(grounding)**: 인용·근거가 실제 메시지 ID에 묶여 서버 검증을 통과한 상태. **커버리지**: LLM이 실제로 읽은 메시지 비율.
- **단일 패스/청크 모드**: 전사를 한 번에 넘기는지, 월 단위로 추출 후 종합하는지.
- **Tier 0**: LLM 없이 통계만으로 만드는 즉시 보고서(통계 스토리 7장 + 뱃지·어워드). **신호 등급**: 업로드 직후 데이터 충분도(EXCELLENT/GOOD/FAIR/WEAK).

## 다음 행동
1. 13 Q4(이메일 인증·완료 메일, 18 P0-1) 결정 → 메일 발송 제공자 선택 후 구현.
2. `LLM_PROVIDER=anthropic`으로 실제 대화 1건 생성해 화법 품질 확인(14 §6 체크리스트) → 07 §5 프롬프트 보정.
3. Docker 데몬이 있는 환경에서 `docker compose up --build` 검증.
4. 18 §12 P1 항목 순서대로(보고서 체인, 공유 OG 이미지, FAQ/support, 유형별 랜딩).
