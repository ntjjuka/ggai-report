# 12. 구현 계획 (한 번에 끝내기 위한 순서)

> 각 스텝은 **산출물 → 검증 명령 → 완료 기준(DoD)** 을 가진다. 앞 스텝의 테스트가 녹색이 아니면 다음 스텝으로 가지 않는다. 총 8스텝.

## 0. 저장소·빌드 스캐폴드
**산출물**
```
ggai-report/
├─ build.gradle.kts  settings.gradle.kts  gradle/libs.versions.toml
├─ docker-compose.yml (postgres:16, 포트 5432, DB ggai)
├─ .env.example (APP_CRYPTO_KEY, ANTHROPIC_API_KEY, DB_URL, DB_USER, DB_PASSWORD)
├─ src/main/java/com/example/ggai/… (04 §3 패키지 골격 + GgaiApplication)
├─ src/main/resources/application.yml (04 §4.5 키), application-local.yml, db/migration/V1__init.sql (05 §3)
├─ src/main/resources/templates/, static/
└─ src/test/… (Testcontainers 베이스 클래스 AbstractIntegrationTest)
```
의존성(libs.versions.toml, 구현 시 최신 패치 확인): spring-boot 3.5.x, java 21, postgresql, flyway-core + flyway-database-postgresql, hibernate 6(Boot 관리), hypersistence-utils-hibernate-63(JSONB), com.anthropic:anthropic-java 3.2.x, thymeleaf, spring-boot-starter-validation, spring-boot-starter-actuator, micrometer-registry-prometheus, logstash-logback-encoder, testcontainers(postgresql, junit-jupiter), wiremock-standalone 3.x, archunit-junit5, commons-compress(zip 안전 검사 보조) 또는 JDK `ZipInputStream`.
**검증** `./gradlew build` 성공, `docker compose up -d` 후 앱 기동 시 Flyway V1 적용, `/actuator/health` UP.
**DoD** 빈 앱 + 스키마 + 테스트 인프라.

## 1. 파서 모듈 (`parser/`)
**산출물** `EncodingDetector`, `ZipTextExtractor`, `KakaoLinePatterns`(03 정규식 상수), `KakaoExportParser`(상태 머신), `CsvKakaoParser`, `SplitFileMerger`, 모델 record들, `ParseException(code)`.
픽스처: `docs/fixtures/*` → `src/test/resources/fixtures/` 복사 + 03 §7 나머지 픽스처 작성 + `*.expected.json` 생성(첫 실행 결과를 사람이 검토 후 커밋).
**검증** `./gradlew test --tests "com.example.ggai.parser.*"`; 결정성 테스트; 퍼징 테스트.
**DoD** 03 §7 전 픽스처 통과, 영문 포맷 포함, 커버리지 ≥90%(parser 패키지).

## 2. 통계 모듈 (`stats/`)
**산출물** `ChatStatsCalculator`(08 §3), `SessionSplitter`, `FunFactsCalculator`, `ScorePriorCalculator`(07 §3.1 prior), `StatsFactsRenderer`(08 §7.1 문장형 사실).
**검증** 경계값 테스트, 픽스처별 통계 골든 JSON.
**DoD** 30만 메시지 합성 입력 3초 이내.

## 3. 도메인·업로드 API
**산출물** 엔티티(`Conversation`, `Participant`, `ConversationStats`, `Report`, `ReportStageResult`, `LlmCallLog`, `AuditEvent`) + 리포지토리, `CryptoService`(AES-GCM), `OwnerTokenService`(발급·해시·쿠키), `ConversationService`(upload/confirm/delete/expire), `RateLimiter`(IP·소유자, Caffeine 또는 DB 카운터), `api/ConversationController`, `GlobalExceptionHandler`(ErrorResponse), DTO records, `MergeSuggester`(toksai 알고리즘 이식).
**검증** 통합 테스트 §3-1,3,10,11,13,14,15(FakeLlmClient 아직 미사용 부분), ArchUnit 의존 규칙.
**DoD** 업로드→확인→통계 조회→삭제가 API로 동작, 에러 포맷 표준.

## 4. 보고서 도메인·워커(LLM은 Fake)
**산출물** `Report` 상태 머신, `ReportService`(create: 대화 행 비관적 락 + seq 채번, cancel, retry, share), `ReportWorker`(폴러·클레임 쿼리·풀), `ReportPipeline`(08 단계 골격, `LlmClient` 인터페이스로 호출), `StaleJobRecoverer`, `RawExpirer`, `StageResultRepository`(멱등 체크포인트), `FakeLlmClient`(테스트 프로파일; 시나리오 스위치), `ReportController`, 진행률 갱신.
**검증** 통합 테스트 §3-1,2,4,5,6,7,8,12. 동시성 테스트(seq 유니크, 활성 1개).
**DoD** Fake로 끝까지 SUCCEEDED, 재기동 복구, 취소, 재시도 동작.

## 5. LLM 통합 (Anthropic)
**산출물** `AnthropicLlmClient`(SDK 클라이언트 빈, `maxRetries(0)`, 타임아웃 10m), `PromptBuilder`(07 §5, 시스템 프롬프트 상수 파일 `prompts/system.txt` 등 리소스), `TranscriptRenderer`, `TokenCounter`(countTokens + 폴백), `Planner`(단일/청크/샘플링/비용), `ChunkExtractor`, `Synthesizer`, `Repairer`, `OutputValidator`(접지·숫자·언어·안전·클램프), `ReportAssembler`, `CostTable`, `LlmCallLogger`.
구조화 출력 record(`ChunkExtraction`, `ReportDraft`, `RepairResponse`)에 `@JsonPropertyDescription`·`@ArraySchema` 부착. `refusal`/`max_tokens` 처리. 프롬프트 캐시(`systemOfTextBlockParams` + `CacheControlEphemeral` TTL 1h).
**검증** WireMock 계약 테스트(11 §4), 프롬프트 스냅샷, 검증기 단위. `-Panthropic=true`로 실제 API 스모크 1회(픽스처 ios → 보고서 생성, 비용 로그 확인).
**DoD** 실제 모델로 보고서 1건 생성, `usage.cacheReadInputTokens > 0`(두 번째 청크부터), 미접지 근거 0 노출.
**주의** SDK 버전별 빌더 메서드명 차이는 컴파일 에러로 확인(README 패키지 표 참고). `fallbacks` 베타 파라미터 빌더가 없으면 클라이언트 측 폴백만 구현.

## 6. 웹 UI
**산출물** Thymeleaf 레이아웃(`layout.html`), 페이지 7종(09 §2), 프래그먼트(참여자 폼, 진행 카드, 보고서 섹션 11종, 공유 카드), 서버 SVG 차트 템플릿(월별·히트맵·답장·선톡·도넛), HTMX 폴링, CSRF 헤더, Tailwind 빌드(`npm` 없이 `tailwindcss` standalone CLI 바이너리 Gradle task), Pretendard 서브셋 폰트, 다크 모드.
**검증** MockMvc 뷰 테스트(상태 200·핵심 텍스트), 수동 모바일 확인, Lighthouse 접근성 ≥90.
**DoD** 업로드부터 공유까지 브라우저만으로 완료 가능.

## 7. 운영·마무리
**산출물** 구조화 로그(PII 금지 검사 테스트), 메트릭(02 §3.5), `/actuator` 보호, Dockerfile(non-root, JRE 21), compose(web+worker+postgres), README(실행·환경변수·내보내기 가이드 링크), 스케줄러(stale 복구 60s, 원문 만료 10m, stage_result 정리 1h), eval 스크립트(11 §5).
**검증** `docker compose up` 전체 기동 → E2E 스모크 스크립트(`scripts/smoke.sh`: 업로드→확인→생성→폴링→공유→삭제) 통과.
**DoD** 02 §6 수용 기준 전부 충족.

## 8. 핵심 코드 스켈레톤 (구현자가 그대로 따라갈 시그니처)
```java
// parser
public final class KakaoExportParser { public ParsedChat parse(List<NamedText> files, ParseLimits limits) }
public record NamedText(String name, String text) {}
public final class ZipTextExtractor { public List<NamedText> extract(byte[] zip, ZipLimits limits) }
public final class EncodingDetector { public DecodedText decode(byte[] bytes) }   // charset, text, fallbackUsed

// stats
public final class ChatStatsCalculator { public ChatStats compute(List<Message> msgs, ParticipantMap map) }

// application
public interface LlmClient {
  <T> StageResponse<T> generate(StageRequest req, Class<T> schema);   // StageRequest: stage, model, system, user, maxTokens, effort, requestKey
  long countTokens(String model, String system, String user);
}
public final class ReportPipeline { public void run(UUID reportId, int attempt) }   // 08 단계, heartbeat 콜백 주입
public final class OutputValidator { public ValidationResult validate(ReportDraft d, EvidenceIndex idx, StatsFacts facts, ScorePriors p) }

// domain
public class Report { void start(int attempt); void progress(Stage s, int pct); void succeed(ReportContent c, Quality q);
                      void fail(String code, String msg); void cancel(); void requeueForRetry(); }
```

## 9. 리스크와 대응
| 리스크 | 대응 |
|---|---|
| 실제 내보내기 포맷이 문서와 다른 변형 존재 | 상태 머신이 미매치 줄을 ORPHAN 경고로 남김 → 운영 초기에 경고율 모니터링, 패턴 추가는 03 갱신 + 픽스처 추가 |
| SDK 빌더 API 차이 | 스텝 5에서 컴파일 루프로 해결, 타입 탐색은 `jar tf`/`javap` |
| 보고서 재미 부족 | 스텝 7 eval 루브릭으로 프롬프트 반복(유머 장치 사용률·콜백 유무) |
| 비용 폭주 | Planner 상한 + 일일 소유자 상한 + 비용 메트릭 알람 |
| 긴 생성 시간 이탈 | 진행 단계 카피 + 링크 복귀 안내, 청크 동시 3 |
