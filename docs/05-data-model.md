# 05. 데이터 모델 (PostgreSQL 16, SQL 마이그레이션 `db/migrations/*.sql` — 0001 초기, 0002 공유 토큰 암호문)

> 2026-11-03 Node 구현 기준으로 갱신 (docs/18 P0-9). §3의 DDL은 `db/migrations/0001_init.sql`을 **그대로** 옮긴 것이고, drizzle 스키마 `src/server/schema.ts`는 이 DDL과 1:1로 수동 동기한다(DDL이 정본). 18 §5·§11-4가 지적한 드리프트 컬럼(`tier0_json`, `merge_suggestions`, `default_focus`, `report_language`, `job_id`, `progress_message`, `error_retryable`, `audit_event.owner_hash`, `ix_audit_*`)은 전부 반영했다.

## 1. ERD (텍스트)
```
conversation 1 ── n participant            (ON DELETE CASCADE; uploader_participant_id 는 DEFERRABLE FK)
conversation 1 ── 1 conversation_stats     (CASCADE)
conversation 1 ── n report                 (CASCADE)
report       1 ── n report_stage_result    (CASCADE)   LLM 원출력 체크포인트(멱등키)
report       1 ── n llm_call_log           (ON DELETE SET NULL)  호출 로그, 본문 없음
audit_event  (FK 없음, 삭제 후에도 남음)   업로드·생성·공유·삭제·만료 이벤트 + 레이트리밋 카운트 소스
schema_migrations                          마이그레이션 러너가 만드는 적용 기록
pgboss.*                                   pg-boss 가 자체 스키마 `pgboss` 에 만드는 큐 테이블(report.job_id 가 잡 ID를 문자열로 보관)
```

## 2. 상태 enum (코드가 쓰는 값, 컬럼은 VARCHAR)
- `conversation.status`: `READY`(파싱 완료) · `RAW_EXPIRED`(원문 삭제, 보고서는 유지). 삭제는 행 자체를 지우므로 `DELETED` 값은 없다.
- `conversation.default_focus`: 위저드 1단계 유형. `AUTO | ROMANCE | FRIENDS_GROUP | FRIEND_ONE | FAMILY | WORK | OTHER`(`src/lib/report/schema.ts FOCUS`), 기본 `'AUTO'`. 업로드 multipart `focus`가 enum 밖이면 무시된다.
- `report.status`: `QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELED`. 되돌림 전이 2개: `FAILED → QUEUED`(사용자 재시도, `attempt_count < WORKER_MAX_ATTEMPTS`), `RUNNING → QUEUED`(stale 복구). `QUEUED|RUNNING → CANCELED`(취소·대화 삭제 선행).
- `report.progress_stage`: `QUEUED | LOAD | STATS | RENDER | CHUNK | SYNTH | VALIDATE | DONE | FAILED`(04 §2.4). `PLAN`·`ASSEMBLE`은 별도 값이 없다.
- `report.focus`: `default_focus`와 같은 7종. `report.resolved_focus`: `AUTO`를 제외한 6종 — `assembleReport`가 결정(AUTO가 아니면 그대로; AUTO면 3인+ → `FRIENDS_GROUP`, 2인은 LLM `relationType.code`가 `/ROM|LOVE|CRUSH|ONE|DATE|SITU/i`에 걸리면 `ROMANCE`, 아니면 `FRIEND_ONE`). 성공 시 `markSucceeded`가 저장.
- `report.tone`: 2026-11-03부터 **항상 `'CASUAL'`**(존댓말 옵션 삭제, ADR-10). 컬럼은 호환을 위해 유지하며 읽는 코드 없음. `report.report_language`: 기본 `'ko'`, 현재 **쓰는 코드 없음**(위저드 언어 단계는 한국어만 활성, 17 결정 8의 자리만 확보). `report.visibility`: 기본 `'FULL'`, 코드에서 읽지 않음(13 ADR-12 플래그).
- `conversation.source_format`: `KAKAO_ANDROID_KO | KAKAO_IOS_DOTTED | KAKAO_PC_BRACKET | KAKAO_CSV | KAKAO_EN`.
- `report_stage_result.stage`: `CHUNK | SYNTHESIS | REPAIR`. `chunk_index`: 청크 번호, 종합 `-1`, 수리 `-2`.
- `llm_call_log.status`: `OK | CACHED | RETRYABLE_ERROR | FATAL_ERROR | REFUSAL | MAX_TOKENS`.
- `audit_event.event_type`(코드에서 쓰는 값): `UPLOAD | REPORT_CREATE | REPORT_DELETE | SHARE_ON | SHARE_OFF | DELETE | RAW_EXPIRE`. DDL 주석에는 `REPORT_DELETE`가 빠져 있다(값 제약은 없으므로 동작엔 영향 없음).
- `report.error_code`: 04 §4.7 표. `error_retryable`은 코드의 `RETRYABLE` 집합을 저장한 것.

## 3. DDL — `db/migrations/0001_init.sql` (원문 그대로)
```sql
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
  share_token_enc  BYTEA,                                -- 0002: 토큰 원문 AES-256-GCM(APP_CRYPTO_KEY, AAD = id)
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
```

### 3.1 컬럼 의미 보충 (DDL 주석에 없는 것)
| 컬럼 | 채우는 곳 | 의미 |
|---|---|---|
| `conversation.raw_sha256` | `uploadConversation` | 디코딩된 `NamedText[]` JSON의 sha256. 같은 소유자 재업로드 멱등 판정 키(`uq_conversation_owner_raw`) |
| `conversation.raw_size_bytes` | 〃 | 그 JSON의 UTF-8 바이트 수(업로드 파일 합계가 아님) |
| `conversation.participant_count` | 〃 | **봇 제외** 참여자 수(제외·병합 반영 전). 유효 참여자 수는 API가 `effectiveParticipantCount`로 계산해 준다 |
| `conversation.text_message_count` | 〃 | `stats.total.textMessages`(봇·시스템 제외 TEXT) |
| `conversation.started_at/ended_at` | 〃 | 첫/마지막 메시지 시각(기기 로컬, TZ 없음). drizzle `mode:"string"` → API는 `YYYY-MM-DDTHH:mm`로 잘라 준다 |
| `conversation.tier0_json` | 업로드·확인 | `Tier0Report`(15 §B.4, 09 §8): `signal`·`signalLabel`·`signalReasons`·`story[7]`·`headline`·`relationLabel`·`lines`·`badges`·`awards`·`signature` |
| `conversation.merge_suggestions` | 업로드 | `{from,into,confidence}[]`(1:1 이름 3~8개일 때만). `participants_confirmed_at`이 채워지면 API는 `[]`로 응답 |
| `participant.is_bot` | 업로드 | `isBotSender(raw_name)`(03 §2.4 / 18 P1-2): `오픈채팅봇`·`오픈채팅 봇`·`채팅봇`·`플레이봇`·`카카오톡 채팅봇` 또는 `^(카카오톡\s?)?(오픈)?(채팅|플레이)\s?봇$`. 봇은 참여자 맵·통계·전사에서 항상 제외, 위저드는 기본 "제외" 체크(해제 가능) |
| `participant.merged_into_id` | 확인 | 대표 참여자. 체인 금지(`MERGE_CHAIN` 400), 맵 생성 시 최대 5홉 해소 |
| `report.participant_snapshot` | 생성 | `{id, name, rawNames[], isUploader}[]` — 생성 시점 매핑 고정. 워커는 이것만 본다 |
| `report.job_id` | 생성·재시도·stale 복구 | pg-boss `send()` 반환 ID(취소 시 `boss.cancel`) |
| `report.progress_message` | 워커 하트비트 | 사용자 노출 진행 문구(≤200자, 09 §5) |
| `report.schema_version` | 성공 | `ReportContent.schemaVersion`(현재 1) |
| `report.quality_json` | 성공 | `ReportContent.quality`(06 §2) — `content_json`에도 같은 값이 들어 있다 |
| `report.share_token_hash` | 공유 켬 | `sha256(token)`. 공유 페이지·`GET /shared/{token}` 조회 키 |
| `report.share_token_enc` | 공유 켬 | 토큰 원문의 AES-256-GCM 암호문(`APP_CRYPTO_KEY`, AAD = `report.id`). 소유자 화면 `share.url`을 새로 고침·재배포 뒤에도 같은 링크로 보여 주기 위한 것. 0002 이전에 켠 공유는 NULL(화면은 "링크 다시 만들기") |
| `audit_event.owner_hash` | 서비스 | 소유자 해시(보고서 일일 상한 카운트 키). `ip_hash`는 업로드 상한 키 |

## 4. drizzle · 서비스 계층 메모 (`src/server/schema.ts`, `src/server/services/*`)
- 테이블 정의는 `pgTable`로 DDL과 1:1. JSONB는 `$type<…>()`로 TS 타입만 입힌다(런타임 검증 없음): `parse_warnings → ParseWarnings`, `tier0_json → Tier0Report`, `merge_suggestions → {from,into,confidence}[]`, `stats_json → ChatStats`, `participant_snapshot → ParticipantSnapshotEntry[]`, `content_json → ReportContent`, `quality_json → ReportContent["quality"]`, `result_json → unknown`.
- 시각: `TIMESTAMP`(TZ 없음, 대화 시각)는 `mode: "string"`, `TIMESTAMPTZ`(서버 시각)는 `mode: "date"`. 섞지 않는다. `bytea`는 `customType`.
- 상태 전이는 **서비스 함수의 CAS UPDATE로만** 한다(`claimReport`, `heartbeat`, `markSucceeded`, `markFailed`, `cancelReport`, `retryReport`, `recoverStaleReports`). 상태 컬럼을 다른 곳에서 직접 set하지 않는다. 불가 전이는 409 `INVALID_STATE`.
- 소유자 격리는 모든 조회에 `owner_token_hash = ?`를 조인/조건으로 붙여서(`findOwnedConversation`, `findOwnedReport`) 불일치 시 404.
- 알려진 비용: `findOwnedConversation`·`loadMessagesForReport`가 `select()`로 전체 행을 읽으므로 `raw_cipher`(최대 수십 MB)도 함께 끌어온다. 목록 화면이 없어 현재는 문제가 없지만 목록을 만들 때는 컬럼을 골라 읽어야 한다.
- 소유자 토큰은 해시만 저장(`owner_token_hash`). 공유 토큰은 해시(조회 키) + 암호문(`share_token_enc`, 표시용)을 함께 저장한다 — DB만 유출돼도 키(`APP_CRYPTO_KEY`) 없이는 링크를 만들 수 없고, web은 무상태라 어느 인스턴스에서 조회해도 `share.url`이 같다(13 ADR-27). 2026-11-03까지 쓰던 프로세스 메모리 캐시(`shareTokenCache`)는 제거했다.

## 5. 보존·삭제 (코드 동작)
| 대상 | 규칙 | 구현 |
|---|---|---|
| 원문 `raw_cipher` | 업로드 + `RAW_RETENTION_DAYS`(7)일 → NULL, `status='RAW_EXPIRED'`, `audit RAW_EXPIRE` | 워커 10분 주기 `expireRawConversations`. 만료 연장(슬라이딩)은 **없음**(18 P1-1 백로그) |
| 통계·보고서 | 사용자가 지우기 전까지 | - |
| 대화 삭제 | `QUEUED|RUNNING` 보고서를 먼저 `CANCELED`로 → `DELETE conversation` → CASCADE(participant·stats·report·stage_result), `llm_call_log.report_id`는 SET NULL(숫자만 남음) → `audit DELETE` | `deleteConversation`, `DELETE /api/v1/conversations/{id}` |
| 보고서 단위 삭제 | `QUEUED|RUNNING`이면 409 `INVALID_STATE`(먼저 취소), 아니면 `DELETE report` → CASCADE(stage_result), `llm_call_log` SET NULL, 공유 토큰도 함께 사라짐 → `audit REPORT_DELETE` | `deleteReport`, `DELETE /api/v1/reports/{reportId}` (docs/18 P0-8) |
| LLM 원출력 `report_stage_result` | 생성 후 `STAGE_RESULT_RETENTION_HOURS`(24)시간 뒤 삭제 — **보고서가 `SUCCEEDED`인 경우만**. FAILED 보고서의 체크포인트는 재시도 재사용을 위해 보고서가 삭제될 때까지 남는다 | 워커 60분 주기 `cleanupStageResults` |
| `audit_event` | 정리 없음(무기한). 10 §1의 "90일"은 목표치이며 **미구현** | - |
| `llm_call_log` | 정리 없음 | - |
| pg-boss 잡 | pg-boss 기본 유지보수(`supervise: true`는 워커만) | - |

## 6. 마이그레이션 규칙 (`src/server/migrate.ts`)
- 러너: `db/migrations/*.sql`을 파일명 정렬 순으로 읽어 `schema_migrations(version TEXT PK, applied_at)`에 없는 파일만 적용. 파일 하나 = 트랜잭션 하나. 동시 기동 보호는 `pg_advisory_lock(727272)`.
- 실행 경로: `pnpm db:migrate`(dotenv로 `.env` 읽음) · 워커 기동 시 `MIGRATE_ON_START !== "false"`(compose 기본 `"true"`) · 통합 테스트 `beforeAll`.
- 규칙: 변경은 항상 **새 버전 파일**(`0002_….sql`). 기존 파일 수정 금지(이미 적용된 DB에서 재실행되지 않는다). 같은 PR에서 `src/server/schema.ts`를 함께 갱신한다. JSONB 구조 변경은 `schema_version` 증가 + 읽기 분기(현재 `ReportContent.schemaVersion = 1`, `inlineEvidence`는 구버전 호환을 위해 선택 필드).
- 롤백 SQL은 두지 않는다(전진 전용). 되돌릴 일은 새 버전으로 쓴다.

> 2026-11-04: `0002_report_share_token_enc.sql` — `report.share_token_enc BYTEA` 추가(위 §3). 워커 기동 시 자동 적용. 데이터 이행 없음(기존 공유는 해시만 있어 화면에서 "링크 다시 만들기"를 1회 안내).

> 2026-11-03: `MessageKind`에 `DATA`(헥스 덤프·해시·base64·로그 덩어리, 03 부록 C) 추가. 저장 형식은 그대로(원문 JSON 안의 `kind` 문자열), 마이그레이션 없음. 통계에서는 첨부(`media.other`)로 센다.
