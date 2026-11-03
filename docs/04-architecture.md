# 04. 아키텍처

## 1. 기술 스택 (결정)
| 영역 | 선택 | 이유 |
|---|---|---|
| 언어/런타임 | Java 21 (virtual threads 사용 안 함, 고정 풀) | 팀 표준 |
| 프레임워크 | Spring Boot **3.5.x** (Web MVC, Validation, Data JPA, Thymeleaf, Actuator) | Jackson 2 기반 → Anthropic Java SDK(Jackson 2 어노테이션)와 마찰 없음. Boot 4(Jackson 3)로 올릴 땐 13 문서 ADR-07 참고 |
| 빌드 | Gradle 8.x Kotlin DSL | - |
| DB | PostgreSQL 16, Flyway | JSONB 보고서 저장, `FOR UPDATE SKIP LOCKED` 큐 |
| LLM | `com.anthropic:anthropic-java:3.2.0` (구현 시 최신 3.x 확인) | 구조화 출력(`outputConfig(Class)`), 프롬프트 캐시, 토큰 카운트 |
| 프론트 | Thymeleaf + HTMX 2 + Alpine.js(소량) + Tailwind(빌드: `tailwindcss` CLI, dev는 CDN) | 백엔드 개발자 단독 구현 가능, 보고서는 서버 렌더 |
| 테스트 | JUnit 5, AssertJ, Testcontainers(PostgreSQL), WireMock(LLM), ArchUnit(패키지 의존 규칙) | - |
| 관측 | Micrometer + Prometheus 엔드포인트, logback JSON 인코더 | - |
| 배포 | 단일 컨테이너(web+worker 동일 이미지, 프로파일로 역할 분리 가능) + Postgres. Docker Compose 제공 | - |

## 2. 전체 구성도
```
[브라우저] --HTTPS--> [Spring Boot: web]
   │  업로드(multipart)      │  ① 파싱(동기) → conversation/participant/stats 저장(원문 암호화)
   │  보고서 생성 요청        │  ② report(QUEUED) INSERT (트랜잭션 커밋)
   │  폴링 /reports/{seq}    │
   └────────────────────────┘
                 ▲
                 │ 동일 프로세스(or 별도 프로세스, 프로파일 worker)
        [ReportWorker 폴러 2초]
            ③ SELECT … WHERE status='QUEUED' FOR UPDATE SKIP LOCKED → RUNNING(attempt+1, heartbeat)
            ④ 파이프라인: 복호화→재파싱→통계→전사 렌더→토큰 계산→(단일/청크)→LLM 호출→검증→content_json
            ⑤ 단계별 체크포인트 report_stage_result 저장(재시도 시 재사용)
            ⑥ SUCCEEDED/FAILED 전이 (CAS: status='RUNNING' AND attempt=현재)
                 │
                 ▼
          [Anthropic API]  (멱등키=stage 해시, 재시도 상한 3, 429/5xx 백오프)
```

## 3. 모듈(패키지) 구조 — 단일 Gradle 모듈, 패키지 경계는 ArchUnit으로 강제
```
com.example.ggai
├─ parser/            순수 Java. Spring 의존 금지. KakaoExportParser, 포맷 패턴, ZipExtractor, EncodingDetector
├─ stats/             순수 Java. ChatStatsCalculator, FunFacts, SessionSplitter(간격 기준 세션)
├─ domain/
│   ├─ conversation/  Conversation, Participant, ConversationStats(Entity) + 도메인 메서드(confirmParticipants, expireRaw, delete)
│   └─ report/        Report(Entity, 상태 머신 메서드 start/succeed/fail/cancel/retry), ReportStageResult, LlmCallLog
├─ application/       서비스 계층(트랜잭션 경계). ConversationService, ReportService, ReportWorker, ReportPipeline
│   └─ llm/           LlmClient(인터페이스) · AnthropicLlmClient · FakeLlmClient(test) · PromptBuilder · TranscriptRenderer · OutputValidator(접지·언어·안전)
├─ infra/             JPA Repository, CryptoService(AES-GCM), Clock, 설정 프로퍼티(@ConfigurationProperties), RateLimiter
├─ api/               REST 컨트롤러(/api/**), DTO(record), 예외 핸들러(ErrorResponse{code,message,fieldErrors})
├─ web/               Thymeleaf 컨트롤러(페이지), 뷰 모델 매퍼, 공유 페이지
└─ GgaiApplication
```
의존 방향: `api/web → application → domain ← infra`, `parser/stats`는 누구에게도 의존하지 않음. `application.llm`만 Anthropic SDK를 import(ArchUnit 규칙).

## 4. 핵심 설계 포인트

### 4.1 비동기 큐 = DB
- Redis/Kafka 없이 `report` 테이블이 큐. 클레임 쿼리:
  `UPDATE report SET status='RUNNING', attempt_count=attempt_count+1, heartbeat_at=now(), started_at=coalesce(started_at,now()) WHERE id = (SELECT id FROM report WHERE status='QUEUED' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`
- 하트비트: 파이프라인 각 단계 전후 `UPDATE … SET heartbeat_at=now() WHERE id=? AND status='RUNNING' AND attempt_count=?` → 영향 행 0이면 잡 소유권 상실 → 즉시 중단(`JobLostException`).
- stale 복구(스케줄 60초): `RUNNING AND heartbeat_at < now()-3min` → attempt<3이면 `QUEUED`로 되돌림, 아니면 `FAILED(code=STALE_TIMEOUT)`.
- 워커 풀: `ThreadPoolTaskExecutor(core=max=app.worker.concurrency(2), queue=0)`; 폴러는 빈 슬롯 수만큼만 클레임.

### 4.2 트랜잭션 경계와 부수효과
- 업로드: 한 트랜잭션에서 `conversation + participant + stats` 저장. 파싱은 트랜잭션 **밖**(순수 계산)에서 끝낸 뒤 저장만 트랜잭션.
- 보고서 생성 요청: 트랜잭션에서 대화 행 `SELECT … FOR UPDATE` → 실행 중 보고서 존재 검사 → `seq = max+1` → INSERT. 유니크 `(conversation_id, seq)`가 2차 방어.
- 워커 파이프라인은 **긴 트랜잭션을 열지 않는다**. 각 단계 결과 저장은 짧은 트랜잭션(`REQUIRES_NEW`). LLM 호출 중 DB 커넥션을 쥐지 않는다.
- 알림(v2 이메일)은 `TransactionalEventListener(AFTER_COMMIT)` + 별도 트랜잭션. 메인 트랜잭션 오염 금지.

### 4.3 외부 연동(Claude) 규칙
- 모든 호출은 `LlmClient.generate(StageRequest) → StageResponse` 한 인터페이스로. 멱등키 `request_key = sha256(reportId|stage|chunkIndex|promptHash|model)`; 호출 전 `report_stage_result`에 같은 키의 성공 결과가 있으면 재사용(재시도·재기동 시 비용 0).
- 재시도: 429/529(overloaded)/5xx/네트워크 → 지수 백오프(2s,4s,8s) 최대 3회. 400/413 → 즉시 실패(코드 보존). SDK `maxRetries`는 0으로 두고 우리 재시도만 사용(이중 재시도 금지).
- 타임아웃: 호출당 10분. 전체 보고서 실행 상한 25분(초과 시 FAILED `PIPELINE_TIMEOUT`).
- 비용 가드: 호출 전 `countTokens`로 입력 토큰 측정 → 보고서 누적 예상 비용이 상한(기본 $5) 초과면 샘플링 축소, 그래도 초과면 실패.
- 응답은 구조화 출력(JSON 스키마 강제). `stop_reason`이 `max_tokens`면 `maxTokens` 1.5배로 1회 재호출, `refusal`이면 fallback 모델(설정, 기본 `claude-opus-4-8`)로 1회 재호출 후 실패 처리.

### 4.4 원문 보관과 결정성
- 파서는 결정적 → 메시지 전문을 DB에 두지 않고 `index`만으로 참조. 보고서 렌더 시 인용 텍스트는 `content_json`에 **이미 복사**되어 있으므로 원문 삭제 후에도 보고서는 열린다.
- 원문 재파싱이 필요한 경우(재생성)에만 복호화. 복호화 결과는 메모리에만.

### 4.5 설정 키 (application.yml)
```yaml
app:
  persona: { name: 까비서, default-tone: CASUAL }
  upload: { max-bytes: 52428800, max-messages: 300000, max-participants: 60, min-messages: 30 }
  retention: { raw-days: 7 }
  crypto: { key-id: k1, key-base64: ${APP_CRYPTO_KEY} }     # 32바이트. 하드코딩 금지
  llm:
    provider: anthropic                                      # anthropic | fake
    api-key: ${ANTHROPIC_API_KEY}
    chunk-model: claude-sonnet-5-5
    synthesis-model: claude-opus-5-5
    fallback-model: claude-opus-4-8
    single-pass-max-input-tokens: 150000
    chunk-max-input-tokens: 60000
    max-total-input-tokens: 1500000
    max-cost-usd: 5.0
    call-timeout: 10m
    cache-system-prompt: true
  worker: { concurrency: 2, poll-interval: 2s, heartbeat-stale: 3m, max-attempts: 3, pipeline-timeout: 25m }
  limits: { uploads-per-ip-per-hour: 10, reports-per-owner-per-day: 10 }
  share: { base-url: https://example.com }
```

## 5. 배포 토폴로지(MVP)
- 1 컨테이너(web+worker) + Postgres. 수평 확장 시 web N개 + worker M개(동일 이미지, `--spring.profiles.active=worker`에서는 폴러만 활성, web 프로파일은 폴러 비활성).
- 헬스: `/actuator/health`(DB), readiness에 Anthropic 연결은 포함하지 않음(장애 시에도 업로드·열람은 가능해야 함).
- 백업: Postgres 일일 스냅샷. 원문 컬럼은 암호화 상태로 백업됨(키는 별도 비밀 저장소).
