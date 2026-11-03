-- docs/05 데이터 모델 V1 (Node 변형: pg-boss는 자체 스키마 pgboss 를 쓴다)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE conversation (
  id                 UUID PRIMARY KEY,
  owner_token_hash   CHAR(64) NOT NULL,
  title              VARCHAR(200),
  platform           VARCHAR(20) NOT NULL DEFAULT 'KAKAO',
  source_format      VARCHAR(30) NOT NULL,
  status             VARCHAR(20) NOT NULL,              -- READY | RAW_EXPIRED
  raw_sha256         CHAR(64) NOT NULL,
  raw_size_bytes     BIGINT NOT NULL,
  raw_cipher         BYTEA,                             -- nonce(12) || ciphertext || tag(16)
  raw_key_id         VARCHAR(20),
  message_count      INTEGER NOT NULL,
  text_message_count INTEGER NOT NULL,
  participant_count  INTEGER NOT NULL,
  started_at         TIMESTAMP NOT NULL,
  ended_at           TIMESTAMP NOT NULL,
  parse_warnings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  tier0_json         JSONB,                             -- Tier 0 통계 리포트 (LLM 없음)
  merge_suggestions  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 이름 변경 병합 제안 (확인 전까지)
  default_focus      VARCHAR(20) NOT NULL DEFAULT 'AUTO', -- 위저드 1단계 대화 유형
  uploader_participant_id UUID,
  participants_confirmed_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_conversation_owner_raw UNIQUE (owner_token_hash, raw_sha256)
);
CREATE INDEX ix_conversation_expires ON conversation (expires_at) WHERE raw_cipher IS NOT NULL;

CREATE TABLE participant (
  id              UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  raw_name        VARCHAR(100) NOT NULL,
  display_name    VARCHAR(100) NOT NULL,
  merged_into_id  UUID REFERENCES participant(id),
  excluded        BOOLEAN NOT NULL DEFAULT false,
  is_bot          BOOLEAN NOT NULL DEFAULT false,
  message_count   INTEGER NOT NULL,
  first_at        TIMESTAMP NOT NULL,
  last_at         TIMESTAMP NOT NULL,
  position        INTEGER NOT NULL,
  CONSTRAINT uq_participant_name UNIQUE (conversation_id, raw_name)
);
ALTER TABLE conversation ADD CONSTRAINT fk_conversation_uploader
  FOREIGN KEY (uploader_participant_id) REFERENCES participant(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE conversation_stats (
  conversation_id UUID PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
  stats_version   INTEGER NOT NULL,
  stats_json      JSONB NOT NULL,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE report (
  id               UUID PRIMARY KEY,
  conversation_id  UUID NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  status           VARCHAR(20) NOT NULL,                -- QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELED
  focus            VARCHAR(20) NOT NULL,
  resolved_focus   VARCHAR(20),
  tone             VARCHAR(10) NOT NULL,
  focus_question   VARCHAR(300),
  report_language  VARCHAR(8) NOT NULL DEFAULT 'ko',
  visibility       VARCHAR(10) NOT NULL DEFAULT 'FULL',
  persona_name     VARCHAR(30) NOT NULL,
  participant_snapshot JSONB NOT NULL,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  job_id           VARCHAR(64),
  heartbeat_at     TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  progress_stage   VARCHAR(30),
  progress_pct     SMALLINT NOT NULL DEFAULT 0,
  progress_message VARCHAR(200),
  schema_version   INTEGER,
  content_json     JSONB,
  quality_json     JSONB,
  error_code       VARCHAR(50),
  error_message    VARCHAR(500),
  error_retryable  BOOLEAN,
  share_token_hash CHAR(64),
  share_enabled    BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_report_seq UNIQUE (conversation_id, seq),
  CONSTRAINT uq_report_share UNIQUE (share_token_hash)
);
CREATE INDEX ix_report_queue ON report (created_at) WHERE status = 'QUEUED';
CREATE INDEX ix_report_running ON report (heartbeat_at) WHERE status = 'RUNNING';
CREATE UNIQUE INDEX uq_report_one_active ON report (conversation_id) WHERE status IN ('QUEUED','RUNNING');

CREATE TABLE report_stage_result (
  id            BIGSERIAL PRIMARY KEY,
  report_id     UUID NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  stage         VARCHAR(20) NOT NULL,
  chunk_index   INTEGER NOT NULL DEFAULT -1,
  request_key   CHAR(64) NOT NULL,
  model         VARCHAR(50) NOT NULL,
  result_json   JSONB NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stage_request UNIQUE (request_key)
);

CREATE TABLE llm_call_log (
  id                 BIGSERIAL PRIMARY KEY,
  report_id          UUID REFERENCES report(id) ON DELETE SET NULL,
  stage              VARCHAR(20) NOT NULL,
  chunk_index        INTEGER,
  model              VARCHAR(50) NOT NULL,
  request_key        CHAR(64) NOT NULL,
  attempt            SMALLINT NOT NULL,
  status             VARCHAR(20) NOT NULL,              -- OK | RETRYABLE_ERROR | FATAL_ERROR | REFUSAL | MAX_TOKENS | CACHED
  error_type         VARCHAR(50),
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_usd           NUMERIC(10,6),
  latency_ms         INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_llm_call_report ON llm_call_log (report_id);

CREATE TABLE audit_event (
  id              BIGSERIAL PRIMARY KEY,
  event_type      VARCHAR(40) NOT NULL,                 -- UPLOAD | REPORT_CREATE | SHARE_ON | SHARE_OFF | DELETE | RAW_EXPIRE
  conversation_id UUID,
  report_id       UUID,
  ip_hash         CHAR(64),
  owner_hash      CHAR(64),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_ip ON audit_event (event_type, ip_hash, created_at);
CREATE INDEX ix_audit_owner ON audit_event (event_type, owner_hash, created_at);
