# 05. 데이터 모델 (PostgreSQL, Flyway V1)

## 1. ERD (텍스트)
```
conversation 1 ── n participant
conversation 1 ── 1 conversation_stats
conversation 1 ── n report ── n report_stage_result
                              └─ n llm_call_log
```

## 2. 상태 enum
- `conversation.status`: `READY`(파싱 완료) · `RAW_EXPIRED`(원문 삭제, 보고서는 유지) · `DELETED`(행도 삭제하므로 실제론 미사용, 감사 로그용)
- `report.status`: `QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELED`
- `report.focus`: `AUTO | ROMANCE | FRIENDS | GROUP | WORK`
- `report.tone`: `CASUAL | POLITE`
- `report.visibility`: `FULL`(MVP 기본) · `PREVIEW`(v2 게이팅)
- `source_format`: `KAKAO_ANDROID_KO | KAKAO_IOS_DOTTED | KAKAO_PC_BRACKET | KAKAO_CSV | KAKAO_EN`

## 3. DDL — `V1__init.sql`
```sql
CREATE TABLE conversation (
  id                 UUID PRIMARY KEY,
  owner_token_hash   CHAR(64) NOT NULL,                 -- sha256(hex) of 32-byte random token
  title              VARCHAR(200),
  platform           VARCHAR(20) NOT NULL DEFAULT 'KAKAO',
  source_format      VARCHAR(30) NOT NULL,
  status             VARCHAR(20) NOT NULL,              -- READY | RAW_EXPIRED
  raw_sha256         CHAR(64) NOT NULL,                 -- 평문 기준 해시(멱등 재업로드 판정)
  raw_size_bytes     BIGINT NOT NULL,
  raw_cipher         BYTEA,                             -- AES-256-GCM(nonce 12B || ciphertext || tag). NULL이면 만료
  raw_key_id         VARCHAR(20),
  message_count      INTEGER NOT NULL,
  text_message_count INTEGER NOT NULL,
  participant_count  INTEGER NOT NULL,
  started_at         TIMESTAMP NOT NULL,                -- LocalDateTime(기기 로컬, TZ 없음)
  ended_at           TIMESTAMP NOT NULL,
  parse_warnings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  uploader_participant_id UUID,                         -- FK는 아래 ALTER로 (순환)
  participants_confirmed_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,              -- 원문 자동 삭제 시각
  CONSTRAINT uq_conversation_owner_raw UNIQUE (owner_token_hash, raw_sha256)
);
CREATE INDEX ix_conversation_expires ON conversation (expires_at) WHERE raw_cipher IS NOT NULL;

CREATE TABLE participant (
  id              UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  raw_name        VARCHAR(100) NOT NULL,               -- 내보내기 파일의 표시 이름(변경 불가)
  display_name    VARCHAR(100) NOT NULL,               -- 사용자 수정 가능
  merged_into_id  UUID REFERENCES participant(id),     -- 이름 변경 병합: 대표 참여자
  excluded        BOOLEAN NOT NULL DEFAULT false,
  is_bot          BOOLEAN NOT NULL DEFAULT false,
  message_count   INTEGER NOT NULL,
  first_at        TIMESTAMP NOT NULL,
  last_at         TIMESTAMP NOT NULL,
  position        INTEGER NOT NULL,                    -- 등장 순
  CONSTRAINT uq_participant_name UNIQUE (conversation_id, raw_name)
);
ALTER TABLE conversation ADD CONSTRAINT fk_conversation_uploader
  FOREIGN KEY (uploader_participant_id) REFERENCES participant(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE conversation_stats (
  conversation_id UUID PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
  stats_version   INTEGER NOT NULL,                    -- 통계 계산기 버전
  stats_json      JSONB NOT NULL,                      -- 08 §3 ChatStats (메시지 본문 없음, 예외: fun facts 인용 2~3개)
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE report (
  id               UUID PRIMARY KEY,
  conversation_id  UUID NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,                   -- 대화 내 1부터
  status           VARCHAR(20) NOT NULL,
  focus            VARCHAR(20) NOT NULL,
  resolved_focus   VARCHAR(20),                        -- AUTO 해석 결과
  tone             VARCHAR(10) NOT NULL,
  focus_question   VARCHAR(300),
  visibility       VARCHAR(10) NOT NULL DEFAULT 'FULL',
  persona_name     VARCHAR(30) NOT NULL,
  participant_snapshot JSONB NOT NULL,                 -- 생성 시점 참여자 매핑(병합·제외·표시이름·업로더)
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  heartbeat_at     TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  progress_stage   VARCHAR(30),                        -- PARSING | STATS | CHUNK(i/n) | SYNTHESIS | VALIDATING
  progress_pct     SMALLINT NOT NULL DEFAULT 0,
  schema_version   INTEGER,
  content_json     JSONB,                              -- 07 ReportContent (SUCCEEDED일 때만)
  quality_json     JSONB,                              -- coverage, grounding, tokens, cost, models
  error_code       VARCHAR(50),
  error_message    VARCHAR(500),                       -- 사용자 노출용(PII 금지)
  share_token_hash CHAR(64),
  share_enabled    BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_report_seq UNIQUE (conversation_id, seq),
  CONSTRAINT uq_report_share UNIQUE (share_token_hash)
);
CREATE INDEX ix_report_queue ON report (created_at) WHERE status = 'QUEUED';
CREATE INDEX ix_report_running ON report (heartbeat_at) WHERE status = 'RUNNING';
-- 대화당 실행 중 보고서 1개: 부분 유니크 인덱스(2차 방어; 1차는 서비스의 FOR UPDATE)
CREATE UNIQUE INDEX uq_report_one_active ON report (conversation_id) WHERE status IN ('QUEUED','RUNNING');

CREATE TABLE report_stage_result (
  id            BIGSERIAL PRIMARY KEY,
  report_id     UUID NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  stage         VARCHAR(20) NOT NULL,                  -- CHUNK | SYNTHESIS | REPAIR
  chunk_index   INTEGER NOT NULL DEFAULT -1,
  request_key   CHAR(64) NOT NULL,                     -- 멱등키
  model         VARCHAR(50) NOT NULL,
  result_json   JSONB NOT NULL,                        -- 검증 전 LLM 원출력(JSON)
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stage_request UNIQUE (request_key)
);

CREATE TABLE llm_call_log (
  id                BIGSERIAL PRIMARY KEY,
  report_id         UUID REFERENCES report(id) ON DELETE SET NULL,
  stage             VARCHAR(20) NOT NULL,
  chunk_index       INTEGER,
  model             VARCHAR(50) NOT NULL,
  request_key       CHAR(64) NOT NULL,
  attempt           SMALLINT NOT NULL,
  status            VARCHAR(20) NOT NULL,              -- OK | RETRYABLE_ERROR | FATAL_ERROR | REFUSAL | MAX_TOKENS
  http_status       SMALLINT,
  error_type        VARCHAR(50),
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd          NUMERIC(10,6),
  latency_ms        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_llm_call_report ON llm_call_log (report_id);

CREATE TABLE audit_event (
  id          BIGSERIAL PRIMARY KEY,
  event_type  VARCHAR(40) NOT NULL,                    -- UPLOAD | REPORT_CREATE | SHARE_ON | SHARE_OFF | DELETE | RAW_EXPIRE
  conversation_id UUID,                                -- FK 없음(삭제 후에도 남김)
  report_id   UUID,
  ip_hash     CHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 4. 엔티티 설계 메모 (JPA)
- `Conversation`: 도메인 메서드 `confirmParticipants(cmd)`, `expireRaw()`, `assertCanCreateReport()`. `raw_cipher`는 `@Basic(fetch = LAZY)` + 별도 조회 쿼리(목록 조회에 50MB를 끌어오지 않도록 `@Query("select c.rawCipher ...")`).
- `Report`: 상태 전이는 **도메인 메서드만**: `start(attempt)`, `progress(stage,pct)`, `succeed(content, quality)`, `fail(code,msg)`, `cancel()`, `requeueForRetry()`. 불가 전이는 `IllegalStateTransitionException` → 409. 상태 컬럼 직접 set 금지. 전이 UPDATE는 서비스에서 CAS 조건(`status`, `attempt_count`)을 붙인 JPQL `@Modifying` 쿼리로 수행(워커 소유권 보장).
- JSONB 매핑: `hypersistence-utils`의 `JsonType` 또는 Hibernate 6 `@JdbcTypeCode(SqlTypes.JSON)` + Jackson. `content_json`은 `ReportContent` record로 역직렬화(스키마 버전 분기).
- 모든 `TIMESTAMP`(TZ 없음) 컬럼은 `LocalDateTime`, `TIMESTAMPTZ`는 `Instant`. 섞지 않는다.
- 토큰은 **해시만** 저장. 원문 토큰은 발급 응답에 1회 노출(쿠키 세팅)한다.

## 5. 보존·삭제
- 스케줄(10분): `UPDATE conversation SET raw_cipher=NULL, status='RAW_EXPIRED' WHERE raw_cipher IS NOT NULL AND expires_at < now()` + audit.
- 사용자 삭제: `DELETE FROM conversation WHERE id=? AND owner_token_hash=?` → CASCADE. `llm_call_log.report_id`는 SET NULL(비용 통계 유지, 내용 없음).
- `report_stage_result.result_json`은 LLM 원출력(인용 포함)이므로 보고서 SUCCEEDED 후 **24시간 뒤 삭제**(스케줄). 재시도 재사용 창은 24시간.

## 6. 마이그레이션 규칙
- 변경은 항상 새 버전 파일(`V2__…sql`). 기존 파일 수정 금지. JSONB 스키마 변경은 `schema_version` 증가 + 읽기 시 마이그레이션 코드(`ReportContentUpgrader`).
