# 06. API 명세 (Next.js Route Handlers, `/api/v1`)

> 2026-11-03 Node 구현 기준으로 갱신 (docs/18 P0-9). 엔드포인트는 `src/app/api/v1/**/route.ts` 전수 조사, 응답 형태는 `src/server/services/*`의 `interface`를 그대로 옮겼다. 모든 핸들러는 `export const runtime = "nodejs"`, `withApi` 래퍼(`src/server/http.ts`)를 거친다.

## 0. 공통
- **인증 = 소유자 쿠키 `gg_owner`** (`src/server/owner.ts`): 32바이트 CSPRNG `base64url` 토큰. `HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000(1년); Secure`는 `NODE_ENV=production`일 때만. **첫 업로드 응답(`POST /conversations`)에서만 발급**(쿠키가 없을 때). 서버는 `sha256(token)`만 저장·비교. 쿠키가 없거나 32자 미만인 상태로 소유자 리소스에 접근 → `404 NOT_FOUND`(존재 노출 방지). 공개 엔드포인트는 `GET /shared/{token}`만.
- CSRF 토큰·Origin 검증은 없다. 상태 변경은 모두 `POST`/`DELETE`이고 쿠키가 `SameSite=Lax`라 교차 사이트 폼 전송에는 쿠키가 붙지 않는다(10 §3).
- 헤더: 요청 `X-Request-Id`를 수용, 없으면 UUID 발급, 응답에 항상 `X-Request-Id`. 응답은 JSON(UTF-8), 204는 바디 없음.
- 시각 표기: 대화 시각(기기 로컬, TZ 없음)은 `YYYY-MM-DDTHH:mm`(예 `2026-02-22T12:19`), 서버 시각(`createdAt`·`startedAt`·`finishedAt`·`rawExpiresAt`·`participantsConfirmedAt`)은 ISO-8601 UTC(`…Z`).
- **에러 표준** (`src/server/errors.ts toErrorResponse`):
```json
{ "code": "VALIDATION_FAILED", "message": "참여자 설정을 확인해 주세요", "fieldErrors": [ { "field": "merges", "reason": "MERGE_CHAIN: a→b→c" } ] }
```
| HTTP | code | 발생 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | zod 바디 검증 실패(`fieldErrors[].field`는 경로, 없으면 `(root)`), 파일 수 0 또는 21+, multipart 아님, `seq` 비정수, 참여자 확인 규칙 위반 |
| 400 | `UNSUPPORTED_FILE_TYPE` | txt/csv/zip 외 확장자(03 §6) |
| 404 | `NOT_FOUND` | 쿠키 없음·소유자 불일치·없는 리소스·공유 비활성. 메시지 "찾을 수 없어요" |
| 409 | `RAW_EXPIRED` · `NOT_ENOUGH_PARTICIPANTS` · `REPORT_ALREADY_RUNNING` · `INVALID_STATE` | 상태 전이·전제 조건 위반(아래 각 엔드포인트) |
| 413 | `FILE_TOO_LARGE` | 파일 합계 > `UPLOAD_MAX_BYTES`(50MB) |
| 422 | `ENCODING_UNDETECTED` · `NO_MESSAGES` · `TOO_FEW_MESSAGES` · `TOO_MANY_MESSAGES` · `TOO_MANY_PARTICIPANTS` · `ZIP_*` | 파서 오류(03 §6 문구 그대로) |
| 429 | `RATE_LIMITED` | 업로드 IP당 10/시간(`Retry-After: 3600`) · 보고서 생성 소유자당 10/일(`Retry-After: 86400`) |
| 500 | `INTERNAL_ERROR` | 메시지에 `(request id)` 포함, 서버 로그에 `rid=` |
- `UPLOADER_NOT_SELECTED`(구 설계)는 **없다** — 업로더 선택은 모든 유형에서 선택 사항이다.

## 1. 대화(업로드)

### POST `/api/v1/conversations` — multipart/form-data
| 필드 | 타입 | 규칙 |
|---|---|---|
| `files` | file[] 1~20 | `.txt`/`.csv`/`.zip`(zip 안의 txt/csv만 추출). 합계 ≤ 50MB |
| `title` | string(선택) | 공백 제거 후 저장, 200자 절단. 없으면 파일 헤더에서 추출한 제목(없으면 null) |
| `focus` | string(선택) | `AUTO | ROMANCE | FRIENDS_GROUP | FRIEND_ONE | FAMILY | WORK | OTHER`. 그 외 값은 무시(→ `AUTO`). 위저드 1단계 유형이 `defaultFocus`로 저장된다 |
응답 `201 Created` = `ConversationDetail & { reused: false }`. 같은 소유자가 같은 내용(디코딩 텍스트의 sha256)을 다시 올리면 `200 OK` + `reused: true`로 기존 대화를 돌려준다(새 파싱 없음). 쿠키가 없던 요청이면 `Set-Cookie: gg_owner`.

**`ConversationDetail`** (`src/server/services/conversations.ts`):
```jsonc
{
  "conversationId": "uuid",
  "title": "김민지" | null,
  "sourceFormat": "KAKAO_IOS_DOTTED",
  "status": "READY" | "RAW_EXPIRED",
  "messageCount": 18234,            // 파싱된 메시지 수(시스템 줄 포함)
  "textMessageCount": 17110,        // 봇·시스템 제외 TEXT
  "participantCount": 2,            // 봇 제외, 제외·병합 반영 전
  "startedAt": "2024-03-01T21:02", "endedAt": "2026-09-26T11:30",
  "participants": [ { "participantId": "uuid", "rawName": "민지♥", "displayName": "민지", "messageCount": 9200,
                      "firstAt": "2024-03-01T21:02", "lastAt": "2026-09-26T11:30",
                      "isBot": false, "excluded": false, "mergedIntoId": null, "isUploader": true } ],
  "suggestedMerges": [ { "from": "uuid(옛 이름)", "into": "uuid(대표)", "confidence": 0.82 } ],   // 확인 후에는 []
  "warnings": ["ENCODING_FALLBACK_CP949", "NON_MONOTONIC_TIMESTAMP:3", "DEDUPED:1", "ORPHAN_LINES:2", "UNKNOWN_SYSTEM_LINES:1", "DATE_UNKNOWN_BEFORE_SEPARATOR:0"],
  "uploaderParticipantId": "uuid" | null,
  "participantsConfirmedAt": "2026-11-03T05:00:00.000Z" | null,
  "rawAvailable": true,             // raw_cipher 있음 && status != RAW_EXPIRED
  "rawExpiresAt": "2026-11-10T05:00:00.000Z",
  "effectiveParticipantCount": 2,   // 봇·제외·병합 반영 후 유효 참여자 수
  "signal": { "grade": "EXCELLENT" | "GOOD" | "FAIR" | "WEAK", "label": "신호 최상", "reasons": ["텍스트 메시지 17,110개 (충분)", "대화한 날 420일 (충분)"] } | null,
  "tier0": { /* Tier0Report: version, signal, signalLabel, signalReasons, story[7], headline, relationLabel, lines[], badges[], awards[], signature */ } | null,
  "defaultFocus": "ROMANCE",
  "reports": [ { "reportId": "uuid", "seq": 2, "status": "SUCCEEDED", "focus": "ROMANCE", "tone": "CASUAL", "progressPct": 100,
                 "createdAt": "…Z", "finishedAt": "…Z" | null, "headline": "둘 중 한 명만 연애 중이다" | null } ],   // seq 내림차순
  "createdAt": "…Z"
}
```
- `signal.grade`(`src/lib/tier0/story.ts signalLevel`): 텍스트 메시지 ≥ 3,000 **그리고** 대화한 날 ≥ 30 → `EXCELLENT`(신호 최상) · ≥ 800 & ≥ 10 → `GOOD`(신호 좋음) · 텍스트 ≥ 200 → `FAIR`(신호 보통) · 그 외 `WEAK`(신호 약함). `reasons`는 텍스트 수·활동일 평가, 3인+면 참여자 수, `WEAK`면 "보고서는 만들 수 있지만 근거가 얇아 농담보다 숫자가 많을 거예요". `tier0.signal`과 같은 등급(docs/18 P0-5).
- `warnings`는 `parse_warnings`를 코드 문자열로 바꾼 것(0인 항목은 생략).
- 오류: 03 §6 코드, `VALIDATION_FAILED`(파일 수·multipart), `RATE_LIMITED`.

### GET `/api/v1/conversations` → `200` `{ conversations: OwnedConversationSummary[] }` (신규, "내 보고서")
소유자 쿠키로 올린 대화 전부(최신 50건)와 각 대화의 `reports: ReportSummary[]`. 쿠키가 없으면 빈 배열(404 아님). 필드: `conversationId, title, messageCount, participantCount, startedAt, endedAt, status, rawAvailable, rawExpiresAt, signalLabel, createdAt, reports`.

### GET `/api/v1/conversations/{id}` → `200` `ConversationDetail`(`reused` 없음)

### POST `/api/v1/conversations/{id}/participants/confirm` — JSON
```jsonc
{
  "uploaderParticipantId": "uuid" | null,        // 선택. 없으면 null — 모든 유형에서 선택 사항
  "merges": [ { "from": "uuid", "into": "uuid" } ],   // ≤100
  "excluded": ["uuid"],                          // ≤200
  "displayNames": { "uuid": "민지" },             // 값 ≤100자
  "title": "한우방"                                // 선택, ≤200자. 대화방 이름 편집(17 4단계)
}
```
규칙(위반은 400 `VALIDATION_FAILED` + `fieldErrors`): 모든 ID는 이 대화의 참여자, `from === into` 금지, 병합 체인 금지(`MERGE_CHAIN: a→b→c`), 업로더는 제외·병합 대상 불가, 표시 이름 1~100자. 제외·병합·봇 반영 후 유효 참여자 < 2 → 409 `NOT_ENOUGH_PARTICIPANTS`. 원문이 남아 있으면 통계·Tier 0를 재계산(업로더 기준 `balance` 포함). 응답 `200` `ConversationDetail`. 실행 중 보고서가 있어도 허용되며 이후 보고서에만 반영된다(스냅샷).

### GET `/api/v1/conversations/{id}/stats` → `200` `ChatStats`(`src/lib/stats/types.ts`, 08 §3). `statsVersion 1`.

### DELETE `/api/v1/conversations/{id}` → `204`. 실행 중 보고서를 `CANCELED` 처리한 뒤 하드 삭제(CASCADE). 이후 조회는 404.

## 2. 보고서

### POST `/api/v1/conversations/{id}/reports` — JSON(바디 생략 가능)
```json
{ "focus": "AUTO", "focusQuestion": "얘 나한테 관심 있는 거 맞아?" }
```
- 검증: `focus` 7종(기본 `AUTO`), `focusQuestion` ≤300자·nullable. 공백만이면 null 저장. (`tone` 필드는 2026-11-03 삭제 — 보내도 무시된다. 응답의 `tone`은 항상 `"CASUAL"`)
- 409: `RAW_EXPIRED`(원문 만료) · `NOT_ENOUGH_PARTICIPANTS`(스냅샷 2명 미만) · `REPORT_ALREADY_RUNNING`(이 대화에 `QUEUED|RUNNING` 존재). 429: 소유자 일일 10건.
- 응답 `202 Accepted` = `ReportView & { statusUrl: "/api/v1/conversations/{id}/reports/{seq}" }` (`status: "QUEUED"`). 큐 투입에 실패하면 같은 응답이 `status: "FAILED"`, `error.code: "QUEUE_ERROR"`(retryable)로 온다.

### GET `/api/v1/conversations/{id}/reports/{seq}` → `200` `ReportView`
`seq`가 1 이상 정수가 아니면 400. `QUEUED|RUNNING`이면 헤더 `Retry-After: 3`; 항상 `Cache-Control: no-store`. 폴링 권장 3초(UI 구현도 3초). SSE 엔드포인트는 **없다**.

**`ReportView`** (`src/server/services/reports.ts`):
```jsonc
{
  "reportId": "uuid", "conversationId": "uuid", "seq": 2,
  "status": "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED",
  "progress": { "stage": "CHUNK" | null, "pct": 42, "message": "까비서가 2025-03 대화를 읽고 있어요 (3/7)" | null },
  "createdAt": "…Z", "startedAt": "…Z" | null, "finishedAt": "…Z" | null,
  "attemptCount": 1,
  "options": { "focus": "AUTO", "resolvedFocus": "FRIEND_ONE" | null, "tone": "CASUAL", "focusQuestion": "…" | null },
  "content": null | { /* 07 §3 ReportContent (SUCCEEDED 일 때만) */ },
  "quality": null | {                               // SUCCEEDED 일 때만. content.quality 와 동일
    "mode": "SINGLE" | "CHUNKED",
    "chunks": { "total": 1, "succeeded": 1 },
    "evidence": { "total": 41, "dropped": 2 },     // 인라인 m#### 토큰 포함
    "lowFindings": 0, "repaired": false, "unverifiedNumbers": 1,
    "models": { "chunk": null | "claude-sonnet-5-5", "synthesis": "claude-opus-5-5" },
    "tokens": { "input": 81234, "output": 9100, "cacheRead": 2400 },
    "costUsd": 0.5123, "durationSec": 171
  },
  "error": null | { "code": "LLM_UNAVAILABLE", "message": "까비서가 잠깐 자리를 비웠어요. 다시 시도해 주세요", "retryable": true },   // FAILED 일 때만(04 §4.7)
  "share": { "enabled": false, "url": null }       // url 은 enable 을 처리한 인스턴스의 메모리 캐시에 있을 때만 채워짐
}
```
`progress.stage` 값은 05 §2(`QUEUED|LOAD|STATS|RENDER|CHUNK|SYNTH|VALIDATE|DONE|FAILED`).

### GET `/api/v1/reports/{reportId}` → `200` `ReportView` (ID로 직접 조회, 신규)

### DELETE `/api/v1/reports/{reportId}` → `204` (신규, docs/18 P0-8)
보고서 하나만 삭제(대화·다른 보고서·원문은 유지). `QUEUED|RUNNING`이면 409 `INVALID_STATE` "만드는 중인 보고서는 먼저 취소한 뒤 삭제할 수 있어요". 공유 링크도 함께 사라진다. 감사 이벤트 `REPORT_DELETE`.

### POST `/api/v1/reports/{reportId}/cancel` → `200` `ReportView`(`status: "CANCELED"`, `progress.message: "취소됨"`)
`QUEUED|RUNNING`이 아니면 409 `INVALID_STATE`. RUNNING 취소는 즉시 상태를 바꾸고 pg-boss 잡 취소를 시도하며, 워커는 다음 하트비트에서 소유권 상실로 중단한다.

### POST `/api/v1/reports/{reportId}/retry` → `202` `ReportView`(`status: "QUEUED"`, `progress.message: "다시 줄 서는 중"`)
조건: `FAILED` **그리고** `attemptCount < WORKER_MAX_ATTEMPTS(3)` **그리고** 원문 미만료. 위반 시 409 `INVALID_STATE`(상태·횟수) 또는 409 `RAW_EXPIRED`. `attemptCount`는 워커가 클레임할 때 +1 된다.

### POST `/api/v1/reports/{reportId}/share/enable` → `200` `{ "url": "{APP_BASE_URL}/r/{token}" }`
`SUCCEEDED`만 가능(아니면 409 `INVALID_STATE`). 토큰은 32바이트 `base64url`, 재호출하면 **새 토큰 발급·구 토큰 무효**. URL은 이 응답으로만 확실히 받을 수 있다(해시만 저장).

### POST `/api/v1/reports/{reportId}/share/disable` → `200` `{ "enabled": false }`

### GET `/api/v1/shared/{token}` → `200` `SharedReportView` (공개, 쿠키 불필요)
```json
{ "reportId": "uuid", "seq": 2, "content": { "…07 §3 ReportContent…" }, "createdAt": "…Z" }
```
조건: 토큰 길이 ≥ 32, `share_enabled = true`, `status = SUCCEEDED`. 아니면 404. 헤더 `X-Robots-Tag: noindex, nofollow, noarchive`, `Cache-Control: private, no-store`. `content`는 소유자 뷰와 같은 `ReportContent`다(원문 전체가 아니라 인용된 `evidence[].text`만 들어 있다). 소유자 전용 정보(`options`·`error`·`share`·`attemptCount`)는 없다.

## 3. 페이지 (Next.js App Router, `src/app`)
| 경로 | 렌더 | 설명 |
|---|---|---|
| `/` | 서버 | 랜딩: 히어로·3단계·가상 샘플 카드·신뢰 3칸·CTA `/setup` |
| `/setup?c={id}&back={path}` | 클라이언트(`Wizard`) | 7단계 위저드(09 §6). `c`가 있으면 4단계(참여자)부터 기존 대화를 불러온다, `back`은 1단계 뒤로가기 목적지(`/`로 시작하는 경로만) |
| `/guide/export` | 서버 | 내보내기 가이드(Android / iPhone / 휴대폰에서 바로 올리기 / PC / 지원 파일) |
| `/c/{id}` | 서버, `noindex` | 대화 대시보드: 요약·원문 만료일·통계 스토리 링크·"참여자·이름 다시 정리"(→ `/setup?c=`)·보고서 목록·새 보고서 폼·대화 삭제 |
| `/c/{id}/story?then={path}` | 클라이언트(`StoryViewer`), `noindex` | Tier 0 통계 스토리 7장. 마지막 장 버튼은 `then`이 있으면 "{페르소나} 보고서 보기 →", 없으면 "대화로 돌아가기" |
| `/c/{id}/reports/{seq}` | 서버 + 클라이언트 조각, `noindex` | `QUEUED|RUNNING` → 대기 화면(3초 폴링) · `FAILED` → 실패 화면(재시도 가능 시 버튼) · `CANCELED` → 취소 안내 · `SUCCEEDED` → 보고서 + 공유/새 보고서/통계/삭제. 쿼리 `?show=writing`은 링크에 붙지만 **페이지가 읽지 않는다**(상태로 분기) |
| `/r/{token}` | 서버, `noindex` + OG(`card.png`) | 공유 보고서: 상단 "{페르소나} 보고서 · 공유됨", 소유자 액션 없음, 하단 CTA `/setup` |
| `/r/{token}/card.png` | Route Handler(`next/og` ImageResponse) | 1080×1920 공유 카드 PNG(09 §4). 404면 텍스트 "not found" |
| `/privacy`, `/terms` | 서버 | 개인정보 처리 안내(10 §8), 이용 안내 |
| (404) | `not-found.tsx` | "여기엔 아무것도 없어요 … 대화는 만든 브라우저에서만 열 수 있어요" |
`next.config.ts` 헤더: `/r/*`에 `X-Robots-Tag: noindex, nofollow, noarchive`, `/c/*`에 같은 헤더 + `Cache-Control: private, no-store`. **없는 페이지**: `/faq`, `/support`, 유형별 랜딩(`/relationship` 등), 대화 목록("내 보고서") — docs/18 P1-6·P1-11 백로그. 푸터의 문의 링크도 없다(프라이버시 페이지에 "저장소 이슈 트래커" 문구만).

## 4. 레이트리밋·남용 방지
- 저장소 없는 카운터: `audit_event`에서 `UPLOAD`(같은 `ip_hash`, 최근 1시간) ≥ `LIMIT_UPLOADS_PER_IP_PER_HOUR`(10) → 429 · `REPORT_CREATE`(같은 `owner_hash`, 최근 24시간) ≥ `LIMIT_REPORTS_PER_OWNER_PER_DAY`(10) → 429. 재업로드(`reused`)는 레이트리밋 검사 **뒤에** 판정되므로 한도를 소비한다.
- IP는 `x-forwarded-for` 첫 값 → `x-real-ip` → `0.0.0.0`. 프록시 없이 노출하면 모든 요청이 `0.0.0.0`으로 묶인다(배포 시 리버스 프록시 필수).
- 업로드 바디: 서비스 계층에서 파일 합계 50MB 검사. 프레임워크·프록시 수준의 바디 상한은 코드에 설정이 없다(배포 프록시에서 설정 권고).
- 공유 토큰 조회는 해시 비교(`share_token_hash = sha256(token)`)라 타이밍 공격 면이 없다. 토큰 32자 미만은 DB를 보지 않고 404.
- 공개 페이지·API(`/r/*`, `/shared/*`)에는 별도 레이트리밋이 없다(미구현).

## 5. 라우트 → 서비스 매핑
| 라우트 파일(`src/app/api/v1/…`) | 메서드 | 서비스(`src/server/services/…`) | 트랜잭션 |
|---|---|---|---|
| `conversations/route.ts` | POST | `conversations.uploadConversation` | 파싱·통계 밖 → 저장 1 tx |
| `conversations/[id]/route.ts` | GET / DELETE | `getConversationDetail` / `deleteConversation` | - / 취소 UPDATE + DELETE |
| `conversations/[id]/participants/confirm/route.ts` | POST | `confirmParticipants` | 1 tx(참여자·대화·통계) |
| `conversations/[id]/stats/route.ts` | GET | `getStats` | - |
| `conversations/[id]/reports/route.ts` | POST | `reports.createReport` | 1 tx(`FOR UPDATE`) + 커밋 후 enqueue |
| `conversations/[id]/reports/[seq]/route.ts` | GET | `getReportBySeq` | - |
| `reports/[reportId]/route.ts` | GET / DELETE | `getReportById` / `deleteReport` | - / DELETE |
| `reports/[reportId]/cancel/route.ts` | POST | `cancelReport` | CAS UPDATE + `boss.cancel` |
| `reports/[reportId]/retry/route.ts` | POST | `retryReport` | CAS UPDATE + enqueue |
| `reports/[reportId]/share/enable/route.ts` | POST | `enableShare` | UPDATE |
| `reports/[reportId]/share/disable/route.ts` | POST | `disableShare` | UPDATE |
| `shared/[token]/route.ts` | GET | `getSharedReport` | - |
클라이언트는 `src/components/api.ts api()`로 호출한다(에러 표준을 `ClientApiError{status, code, message, fieldErrors}`로 변환, 204는 `undefined`).
