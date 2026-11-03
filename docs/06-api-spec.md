# 06. API 명세 (REST, `/api/v1`)

## 0. 공통
- 인증: 소유자 쿠키 `mr_owner`(HttpOnly, Secure, SameSite=Lax, 1년). 첫 업로드 응답에서 발급. 없는 상태로 소유자 리소스 접근 → 404(존재 노출 방지).
- 헤더 `X-Request-Id` 수용/발급. 응답은 항상 JSON(UTF-8).
- 에러 표준:
```json
{ "code": "UPLOADER_NOT_SELECTED", "message": "내가 누구인지 먼저 선택해 주세요", "fieldErrors": [ { "field": "focusQuestion", "reason": "300자 이하" } ] }
```
- 상태 매핑: 400 검증 실패 `VALIDATION_FAILED` · 404 `NOT_FOUND` · 409 상태 전이 불가/중복 · 413 용량 · 422 파싱 불가 · 429 `RATE_LIMITED`(헤더 `Retry-After`) · 500 `INTERNAL_ERROR`(request id 포함).
- DTO는 모두 Java `record`. Entity 직접 노출 금지. 시간은 ISO-8601, 대화 시각(TZ 없음)은 `2026-02-22T12:19` 형식 그대로.

## 1. 대화(업로드)

### POST `/api/v1/conversations` — multipart
| 필드 | 타입 | 설명 |
|---|---|---|
| `files` | file[] (1..20) | txt/csv/zip. 합계 50MB |
| `title` | string(≤100, 선택) | 미입력 시 헤더에서 추출 |
응답 `201`:
```json
{
  "conversationId": "uuid",
  "sourceFormat": "KAKAO_IOS_DOTTED",
  "title": "김민지",
  "messageCount": 18234, "textMessageCount": 17110,
  "startedAt": "2024-03-01T21:02", "endedAt": "2026-09-26T11:30",
  "participants": [ {"participantId":"uuid","rawName":"김민지","displayName":"김민지","messageCount":9200,"firstAt":"…","lastAt":"…","isBot":false} ],
  "suggestedMerges": [ {"from":"uuid(옛 이름)","into":"uuid(현재 이름)","confidence":0.82} ],
  "warnings": ["ENCODING_FALLBACK_CP949","NON_MONOTONIC_TIMESTAMP:3"],
  "reused": false
}
```
- 같은 소유자 + 같은 `raw_sha256` → 기존 대화 반환 `200`, `reused: true`(멱등).
- 오류: 03 §6 코드. 레이트리밋 IP당 10/시간.

### GET `/api/v1/conversations/{id}` → 대화 상세(위 응답 + `status`, `uploaderParticipantId`, `participantsConfirmedAt`, `rawExpiresAt`, `reports[]` 요약)

### POST `/api/v1/conversations/{id}/participants/confirm`
```json
{
  "uploaderParticipantId": "uuid",
  "merges": [ {"from":"uuid","into":"uuid"} ],
  "excluded": ["uuid"],
  "displayNames": { "uuid": "민지" }
}
```
규칙: 업로더는 제외·병합 대상 불가(400). 병합 체인 금지(into가 다른 from이면 400 `MERGE_CHAIN`). 제외 후 유효 참여자 < 2 → 409 `NOT_ENOUGH_PARTICIPANTS`. 응답 200 대화 상세. 실행 중 보고서가 있어도 허용(이후 보고서에만 반영).

### GET `/api/v1/conversations/{id}/stats` → `ChatStats` JSON(08 §3)

### DELETE `/api/v1/conversations/{id}` → 204. 전부 하드 삭제. 실행 중 보고서는 먼저 CANCELED 처리 후 삭제.

## 2. 보고서

### POST `/api/v1/conversations/{id}/reports`
```json
{ "focus": "AUTO", "tone": "CASUAL", "focusQuestion": "얘 나한테 관심 있는 거 맞아?" }
```
- 검증: focus enum, tone enum, focusQuestion ≤300자(선택).
- 409: `UPLOADER_NOT_SELECTED`, `REPORT_ALREADY_RUNNING`, `RAW_EXPIRED`(원문 만료라 생성 불가), `NOT_ENOUGH_PARTICIPANTS`. 429: 소유자 일일 상한.
- 응답 `202`: `{ "reportId":"uuid", "seq": 2, "status":"QUEUED", "statusUrl":"/api/v1/conversations/{id}/reports/2" }`

### GET `/api/v1/conversations/{id}/reports/{seq}`
```json
{
  "reportId":"uuid","seq":2,"status":"RUNNING",
  "progress": {"stage":"CHUNK","current":3,"total":7,"pct":42,"message":"까비서가 2025년 3월 대화를 읽고 있어요"},
  "createdAt":"…","startedAt":"…","finishedAt":null,
  "options": {"focus":"AUTO","resolvedFocus":null,"tone":"CASUAL","focusQuestion":"…"},
  "content": null,                      // SUCCEEDED면 07 ReportContent
  "quality": null,                      // SUCCEEDED면 {coveragePct, groundedEvidence, droppedEvidence}
  "error": null,                        // FAILED면 {code, message, retryable}
  "share": {"enabled": false, "url": null}
}
```
- 폴링 권장 간격 3초(`Retry-After: 3` 헤더 제공). 선택: `GET …/events`(SSE, `text/event-stream`, 이벤트 `progress`/`done`/`failed`) — v1에 포함하되 폴링이 기본.

### POST `/api/v1/reports/{reportId}/cancel` → 200 `{status:"CANCELED"}`. QUEUED/RUNNING 아니면 409 `INVALID_STATE`. RUNNING 취소는 "요청"이며 워커가 다음 하트비트에서 중단(상태는 즉시 CANCELED, 워커는 소유권 상실로 정리).

### POST `/api/v1/reports/{reportId}/retry` → 202. FAILED이고 attempt<3이고 원문 미만료일 때만. 아니면 409.

### POST `/api/v1/reports/{reportId}/share/enable` → 200 `{ "url": "https://…/r/{token}" }` (토큰은 32바이트 URL-safe, 재호출 시 새 토큰 발급·기존 무효)
### POST `/api/v1/reports/{reportId}/share/disable` → 200
### GET `/api/v1/shared/{token}` → 공개 보고서 뷰 모델(소유자 전용 필드·원문 통계 세부 제외). 비활성/없음 → 404.

## 3. 페이지(Thymeleaf, HTML)
| 경로 | 설명 |
|---|---|
| `/` | 랜딩 + 샘플 + 업로드 CTA |
| `/guide/export` | 카카오톡 내보내기 가이드(Android/iPhone/PC 탭) |
| `/upload` | 업로드 폼(HTMX multipart) → 성공 시 `/c/{id}` 리다이렉트 |
| `/c/{id}` | 대화 대시보드: 참여자 확인 폼, 통계 미리보기, 보고서 목록·생성 폼 |
| `/c/{id}/reports/{seq}` | 보고서(진행 중이면 HTMX 폴링 조각 교체) |
| `/r/{token}` | 공유 보고서(noindex) |
| `/privacy`, `/terms` | 고지 |

## 4. 레이트리밋·남용 방지
- IP 해시 기준 업로드 10/시간, 소유자 토큰 기준 보고서 10/일(설정). 초과 429.
- 업로드 바디 크기는 서버(Tomcat `max-file-size`, `max-request-size`) + 서비스 양쪽에서 검사.
- 공유 토큰 조회는 상수 시간 비교(해시 조회이므로 자연 충족).

## 5. 컨트롤러 → 서비스 매핑 (구현 체크리스트)
| 엔드포인트 | 서비스 메서드 | 트랜잭션 |
|---|---|---|
| POST conversations | `ConversationService.upload(files, ownerToken, ip)` | 파싱(밖) → `save()` 트랜잭션 |
| confirm | `ConversationService.confirmParticipants(id, owner, cmd)` | 1 |
| DELETE | `ConversationService.delete(id, owner)` | 1 (+ 실행 중 보고서 cancel 선행) |
| POST reports | `ReportService.create(id, owner, options)` | 1 (대화 행 `PESSIMISTIC_WRITE`) |
| GET report | `ReportQueryService.get(id, seq, owner)` | readOnly |
| cancel/retry | `ReportService.cancel/retry(reportId, owner)` | 1, CAS |
| share | `ReportService.enableShare/disableShare` | 1 |
| shared | `ReportQueryService.getShared(token)` | readOnly |
