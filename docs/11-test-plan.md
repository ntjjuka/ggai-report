# 11. 테스트 계획

## 1. 레벨별 구성
| 레벨 | 도구 | 대상 | 실행 |
|---|---|---|---|
| 단위 | JUnit5 + AssertJ | parser, stats, validator, prompt builder, 상태 머신 | `./gradlew test` (매 커밋) |
| 통합 | Spring Boot Test + Testcontainers(PostgreSQL 16) + FakeLlmClient | 업로드→확인→보고서 전체 흐름, 워커, 삭제, 공유 | `./gradlew integrationTest` |
| 계약 | WireMock | Anthropic API 응답 형태별 처리 | 단위에 포함 |
| 품질(eval) | 스크립트 + 실제 모델(옵트인) | 보고서 품질 루브릭 | `./gradlew eval -Panthropic=true` (수동) |
| 성능 | JMH 또는 단순 타이머 테스트 | 50MB 파싱, 30만 메시지 통계 | 야간/수동 |
| 보안 | 단위+통합 | zip 안전, 소유자 격리, 토큰 해시, 로그 PII | 매 커밋 |

## 2. 단위 테스트 명세

### 2.1 파서 (golden)
- 03 §7 픽스처 각각 → `ParsedChat`를 JSON으로 직렬화해 `*.expected.json`과 비교. 변경 시 의도적 갱신만 허용(리뷰).
- 개별 규칙 테스트: 12시간제 변환 4케이스(오전12/오후12/오후1/오전8), 첫 `" : "`만 구분자, 멀티라인 병합·빈 줄 보존, 헤더 줄 비병합, 날짜 구분선 3종, 콤마형 시스템 줄→SYSTEM kind, 대괄호 없는 시스템 줄, 미디어 분류 전체 표, `파일:` 파일명, 영문 `invited … and …`, `The message has been deleted.`, BOM 선두, CP949 폴백 경고, UTF-16 BOM, 분할 파일 경계 중복 제거, 시간 역행 경고, 이름에 이모지/대괄호/괄호, CSV 따옴표·멀티라인, 한도 초과 각 코드, `NO_MESSAGES`.
- 결정성: 같은 입력 2회 파싱 → 동일 index/해시.
- 퍼징(소형): 무작위 줄 섞기/절단 1,000회 → 예외는 `ParseException` 계열만, 무한 루프 없음(타임아웃 5초).

### 2.2 통계
- 선톡/세션: 간격 6h 경계값(5h59 vs 6h00). 답장 지연: 같은 화자 연속 제외, 경계 표시 제외, 분 해상도 0초 처리.
- 히트맵 합 = 텍스트 메시지 수. 월별 합 일치. 균형 지표 부호(업로더 기준).
- fun facts: 최장 침묵 index, 골든아워 argmax, 종결자 카운트.
- 단톡 제외 참여자 경계 생성 수.

### 2.3 전사 렌더·플래너
- ID 연속성(m0..), 미디어 축약, URL 도메인화, 전화번호/계좌 마스킹 정규식 양·음성 케이스, 멀티라인 들여쓰기.
- 모드 결정 경계(150k), 월 버킷 분할·병합, 샘플링 커버리지 계산, 비용 추정 공식, 상한 초과 → `COST_LIMIT_EXCEEDED`.

### 2.4 검증기
- 근거 ID 미존재/화자 불일치 제거, 발견 LOW 강등, 숫자 불일치 탐지(허용 숫자 집합 vs 본문 숫자 추출), 한자·가나 탐지(정상 한국어·영문·숫자·이모지는 통과), 금지 키워드, 점수 클램프 ±40, 참여자 누락 보완, 배열 길이 절단.

### 2.5 프롬프트 빌더
- 스냅샷 테스트: 고정 입력 → 시스템/사용자 프롬프트 문자열 골든 비교(캐시 안정성 보장: 시스템 프롬프트에 가변 값 없음 검사 — 날짜/UUID 정규식 0건).

### 2.6 도메인 상태 머신
- `Report` 전이 표 전수: 허용 전이 성공, 비허용 전이 `IllegalStateTransitionException`. `Conversation.confirmParticipants` 규칙(업로더 제외 불가, 병합 체인 금지, 최소 2명).

## 3. 통합 테스트 (Testcontainers + FakeLlmClient)
FakeLlmClient: 입력 전사의 ID 집합에서 결정적으로 근거를 고르고 고정 템플릿 JSON을 반환. 시나리오 스위치: 정상 / 특정 청크 실패 / refusal / max_tokens / 429 지속 / 한자 포함 출력 / 환각 ID 출력.
1. **해피패스 1:1**: 업로드(ios 픽스처) → 201 → confirm → POST reports 202 → 워커 실행 → SUCCEEDED → GET content 필수 섹션(verdict·dynamic·weekChanged·participants·findings·whatIWouldDo·awards·shareCard)·점수(설정 on 시 5)·근거 text 채움·signature 존재·quality.coverage=100. 화법 체크(14 §6)의 결정적 항목(헤드라인 길이·"그런데 m" 패턴·상담사 어휘 0)도 Fake 출력에 대해 검증기 통과 확인.
2. **단톡 8명**: 제외 2명 + 병합 1건 → participants 길이 = 6, 경계 표시 수 > 0.
3. **멱등 업로드**: 같은 파일 재업로드 → 200 reused. 다른 소유자 → 201 신규.
4. **동시 생성**: 같은 대화에 POST reports 2개 동시(ExecutorService) → 하나 202, 하나 409 `REPORT_ALREADY_RUNNING`. seq 유니크 유지.
5. **워커 복구**: RUNNING 중 하트비트를 과거로 강제 → 복구 스케줄 → QUEUED 재클레임 → 체크포인트 재사용(Fake 호출 카운트 증가 없음) → SUCCEEDED.
6. **취소**: RUNNING 중 cancel → CANCELED, 워커 다음 하트비트에서 `JobLostException`, 상태 불변.
7. **실패·재시도**: 429 지속 → FAILED `LLM_UNAVAILABLE` retryable → retry 202 → 정상 시나리오로 SUCCEEDED, attempt=2.
8. **환각 ID**: Fake가 존재하지 않는 `m999999` 근거 반환 → content에 해당 근거 없음, quality.evidence.dropped=1.
9. **한자 출력**: REPAIR 호출 1회 발생, 최종 content에 한자 0.
10. **원문 만료**: expires_at 과거 → 스케줄 → raw NULL, status RAW_EXPIRED, 기존 보고서 열람 OK, 새 보고서 409 `RAW_EXPIRED`.
11. **삭제**: DELETE → 204 → 모든 테이블 잔존 0, llm_call_log.report_id NULL, 공유 토큰 404.
12. **공유**: enable → URL → GET shared 200(소유자 필드 없음) → 재발급 시 구 토큰 404 → disable → 404.
13. **소유자 격리**: 다른 쿠키로 GET → 404.
14. **에러 포맷**: 검증 실패 400 바디 `{code, message, fieldErrors[]}`.
15. **레이트리밋**: 11번째 업로드 429 + `Retry-After`.

## 4. 계약 테스트 (WireMock ↔ AnthropicLlmClient)
- 정상 구조화 출력 응답 파싱 → record 매핑.
- `stop_reason: max_tokens` → maxTokens 1.5배 재호출(요청 바디 검증).
- `stop_reason: refusal` + `stop_details` → 폴백 모델 재호출 1회 → 두 번째도 refusal → `LLM_REFUSED`.
- 429 → 백오프 재시도 3회 후 `LLM_UNAVAILABLE`(지연 측정은 가짜 시계).
- 400 → 즉시 `LLM_BAD_REQUEST`, 재시도 0회.
- 요청 바디 스냅샷: `system` 블록에 `cache_control` 존재, `temperature` 부재, 모델 ID 정확.
- `countTokens` 실패 시 추정치 폴백.

## 5. 품질 평가(eval) — 수동/야간, 실제 모델
데이터: 가상 대화 6종(각 1,500~8,000 메시지, 스크립트로 생성 + 수작업 편집):
`A 균형 연애` · `B 일방(업로더가 더 달림)` · `C 일방(상대가 더 달림)` · `D 친구 티키타카` · `E 단톡 8명(유령 2, 총무 1, 밈 1)` · `F 갈등→회복`.
루브릭(결정적 체크 + LLM 심사 `claude-haiku-5-5`):
| 항목 | 기준 |
|---|---|
| 접지 | 노출 근거 100% 실제 메시지(결정적) |
| 숫자 | 본문 숫자가 통계 사실 집합에 존재(결정적) |
| 언어 | 한자·가나 0(결정적) |
| 방향성 | B/C에서 판정·관계 유형이 기울기를 올바른 방향으로 언급(심사) |
| 다양성 | 발견 6개 주제 중복 ≤1(심사) |
| 재미 | 유머 장치 사용 ≥3종, 숫자 직격 ≥2회, 콜백 ≥1(심사, 1~5점) |
| 안전 | 금지 주제 0(결정적 키워드 + 심사) |
| 길이 | headline ≤40자, 각 섹션 길이 범위(결정적) |
결과를 `eval/results/{date}.json`에 저장, 프롬프트 변경 PR마다 비교. 비용 상한 1회 $15.

## 6. 성능 테스트
- 50MB 합성 파일(100만 줄) 파싱 < 20초, 힙 < 1GB(`-Xmx1g`에서 OOM 없음).
- 30만 메시지 통계 < 3초. 전사 렌더 < 2초.

## 7. 보안 테스트
- zip: `../etc/passwd` 엔트리 거절, 2,001 엔트리 거절, 100배 압축률 거절, 중첩 zip 무시.
- 확장자 위장(`.txt`인 바이너리) → `ENCODING_UNDETECTED`/`NO_MESSAGES`.
- 로그 검사: 통합 테스트 중 수집한 로그에 픽스처 메시지 본문·이름 문자열 0건(ListAppender).
- 토큰: DB에 평문 토큰 0건(해시 길이 64 검사).

## 8. 수동 체크리스트(릴리즈 전)
- 실제 기기 내보내기 파일 각 1개(Android/iPhone/PC)로 업로드 성공 — 가족·본인 대화로만, 테스트 후 삭제.
- 모바일 사파리/크롬에서 보고서 스크린샷 가독성.
- 공유 링크를 비로그인 브라우저에서 열어 소유자 기능 노출 없음 확인.
