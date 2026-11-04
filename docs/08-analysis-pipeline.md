# 08. 분석 파이프라인 (워커)

## 1. 단계 개요
```
claim → [1] LOAD      원문 복호화·재파싱·참여자 스냅샷 적용(병합/제외/표시이름)
      → [2] STATS     결정적 통계(ChatStats) 계산(저장된 것과 동일해야 함; 스냅샷 반영 버전은 보고서용으로 재계산)
      → [3] RENDER    전사(transcript) 렌더: 메시지 ID 부여, 미디어/시스템 축약, 토큰 측정
      → [4] PLAN      단일 패스 vs 청크 모드 결정, 비용 추정, 샘플링 계획
      → [5] CHUNK×n   (청크 모드) 청크별 추출 호출 → ChunkExtraction JSON (체크포인트)
      → [6] SYNTH     종합 호출 ×2 동시(장면·인물 / 판정·나머지, 공유 문맥 캐시) → 합쳐서 ReportDraft JSON (갈래별 체크포인트)
      → [7] VALIDATE  접지·언어·안전·범위 검증, 필요 시 REPAIR 호출 1회
      → [8] ASSEMBLE  ReportContent(07) 조립: 인용 텍스트 채우기, 통계 비주얼 데이터 결합, 품질 메타
      → succeed (CAS)
```
각 단계 전후 `heartbeat()`; 소유권 상실 시 `JobLostException`으로 조용히 종료. 진행률: LOAD 5 → STATS 10 → RENDER 15 → CHUNK 15~70(선형) → SYNTH 85 → VALIDATE 95 → 100.
> 코드 기준 `progress_stage` enum(2026-11-03, `src/worker/pipeline.ts`·`services/reports.ts`): `QUEUED | LOAD | STATS | RENDER | CHUNK | SYNTH | VALIDATE | DONE | FAILED` — `PLAN`·`ASSEMBLE`은 별도 진행 값이 없고 `REPAIR`는 `llm_call_log.stage`로만 존재. 실제 pct는 LOAD 2→5 · STATS 10 · RENDER 15 · CHUNK 15~70 · SYNTH 78 · VALIDATE 92 · DONE 100 (05 §2, 09 §5).

## 2. [1] LOAD
- `report.participant_snapshot`을 사용(생성 시점 매핑 고정). 병합: `merged_into`를 따라 대표 참여자로 치환. 제외/봇/시스템은 전사에서 제거하되, 단톡방에서 제외 참여자가 끼어든 구간은 `[다른 참여자 메시지 N개 생략]` 경계로 표시(답장 추정 오염 방지, toksai 방식).
- 표시 이름은 스냅샷의 `displayName`을 쓴다(LLM도 이 이름만 본다). 업로더는 전사에서 `(나)` 표식 추가: `민지(나)`.

## 3. [2] STATS — `ChatStats` (stats_json, 보고서 비주얼·점수 prior 공용)
```
total: messages, textMessages, media{photo,video,emoticon,voice,file}, deleted, links
period: startedAt, endedAt, days, activeDays
perPerson[pid]: messages, chars, avgLen, share%, initiations(세션 시작 수), replyMedianSec, replyP90Sec,
                emoticons, photos, laughs(ㅋ/ㅎ 문자 수), questions(?), exclaims(!), lateNight(0~5시), links, mentions
sessions: 간격 ≥ 6h 로 세션 분할. count, avgLenMsgs, enderCounts[pid](세션 마지막 발화자)
rhythm: heatmap[7][24], monthly[{month,total,perPerson}], weeklyTrend(최근 12주)
turnTaking: avgConsecutive[pid](연속 발화 평균), interruptionRate(단톡)
funFacts: goldenHour, busiestDay, longestSilence{hours, brokenBy, brokenAt, messageIndex}, firstMessage(index), topEmoji[pid],
          longestMessage{pid,index,len}, mostLaughs{pid}, nightOwl{pid,count}, ghostStreak{pid,days}(단톡: 최장 무발화 기간)
balance(1:1): messageRatio, initiationRatio, replySpeedRatio, questionRatio → -1..1 (양수면 업로더가 더 기울어짐)
```
- 답장 지연: 직전 메시지가 **다른 사람**이고 간격 < 6h이고 경계 표시 없음일 때만 집계(분 해상도 → 0초는 "1분 미만"으로 표기).
- `stats_version=1`. 인용이 들어가는 fun fact(첫 메시지·침묵 깬 메시지·최장 메시지)는 **index만** 저장하고 보고서 조립 시 텍스트를 채운다.

## 4. [3] RENDER — 전사 형식
> 2026-11-03 **압축 전사**로 교체 (docs/19, 토큰 22~45% 절감). 구현 `renderTranscript`(`src/lib/report/transcript.ts`):
> - 날짜가 바뀔 때만 `## 2026-09-25 (금)` 헤더, 각 줄은 `mID HH:MM 이름(나): 본문` (줄마다 날짜·대괄호 없음)
> - 같은 사람이 2분 안에 연달아 보낸 메시지는 최대 8개·320자까지 한 줄로: `m200~m203 20:06 이름: 오늘 / 뭐해 / 심심해`. 모든 ID는 근거 색인에 그대로 남으므로 모델은 묶음 안 어느 ID든 인용할 수 있다(프롬프트의 `[전사 형식]` 설명)
> - 본문 압축: `ㅋㅋㅋㅋㅋ`→`ㅋㅋㅋ`, `!!!!`→`!!`, 줄바꿈→` ⏎ `, 같은 내용 반복(`[사진]` 연속)→`[사진] ×3`. 통계는 원문으로 계산한다
> - `renderLine`(하이라이트 후보처럼 문맥 밖 한 줄)은 날짜를 포함한 `mID 2026-09-25 20:06 이름: 본문`
> - **첨부 제외(2026-11-03)**: 사진·동영상·이모티콘·음성·파일·지도·연락처와 삭제·빈 메시지는 전사에 넣지 않는다(`buildTranscript`가 `kind === "TEXT"`만 통과). 첨부 수는 통계 사실(`사진 N장`, `첨부 M개 별도`)로만 전달한다. 통계의 지분·정렬·균형(`share`, `balance.messageRatio`, 참여 균형 prior, Tier 0 "누가 더 많이"·그룹 방송국 지표)도 **텍스트 메시지 기준**이다. `total.messages`는 전체(첨부 포함) 수로 남겨 둔다.
> 아래 절의 예시 형식은 이전 버전이다.
```
# 참여자: 민지(나), 지훈   # 기간: 2024-03-01 ~ 2026-09-26   # 총 17,110개 텍스트 메시지
m0 [2024-03-01 21:02] 지훈: 안녕! 오늘 잘 들어갔어?
m1 [2024-03-01 21:05] 민지(나): ㅇㅇ 방금 도착
m2 [2024-03-01 21:05] 민지(나): [사진]
m3 [2024-03-01 21:06] 지훈: 와 분위기 좋다
     (멀티라인 2행째는 5칸 들여쓰기)
-- 2024-03-02: 지훈님이 민지님을 초대했습니다 --        ← 시스템은 대시로 축약, ID 없음
[다른 참여자 메시지 12개 생략]                            ← 단톡 초점 모드 경계
```
- 미디어: `[사진]`, `[사진 3장]`, `[동영상]`, `[이모티콘]`, `[음성]`, `[파일: 이름]`, `[삭제됨]`.
- URL은 도메인만 남긴다(`[링크: youtube.com]`) — 토큰 절약·PII 축소. 전화번호(`01[016789]-?\d{3,4}-?\d{4}`)·계좌번호 패턴은 `[전화번호]`·`[계좌]`로 마스킹. 주민번호 패턴 마스킹.
- 연속 동일 화자 1분 내 짧은 메시지는 **병합하지 않는다**(ID 보존이 더 중요). 대신 토큰이 모자라면 샘플링(§5)으로 줄인다.
- 토큰 측정: `client.messages().countTokens()`로 전사 전체 1회(비용 0). 실패 시 추정치 `chars/1.6`.

## 5. [4] PLAN
```
T = 전사 토큰
if T <= single-pass-max(150k):  mode=SINGLE  (종합 호출에 전사 전체 포함)
else:                           mode=CHUNKED
  청크 분할: 월 단위 버킷 → 버킷이 chunk-max(60k) 초과면 세션 경계에서 추가 분할, 미달 월은 인접 월과 합치되 60k 이내
  if Σ청크 토큰 > max-total(1.5M): 각 청크에서 문맥 창 샘플링(toksai renderBucketText: 연속 창 2~8개 균등 배치)으로 비율 축소,
                                   coverage = 포함 메시지/전체 메시지
비용 추정 = Σ(입력×단가_in + 예상출력×단가_out); > max-cost 면 축소 재계획, 그래도 초과면 FAILED COST_LIMIT_EXCEEDED
```
단가(2026-10 기준, 설정 테이블로 둠): Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 (입력/출력 per 1M). 예시: 2만 메시지(약 35만 토큰) → 청크 6개×60k Sonnet ≈ $0.72 + 출력 6×3k ≈ $0.18, 종합 Opus 입력 ≈ 30k($0.12) + 출력 8k($0.16) → **≈ $1.2**. 3천 메시지(6만 토큰) 단일 패스 Opus ≈ $0.26 + $0.16 → **≈ $0.42**.

## 6. [5] CHUNK 호출 (청크 모드만)
- 모델 `chunk-model`, 구조화 출력 `ChunkExtraction`(07 §4.1), `maxTokens 8000`, effort MEDIUM, 시스템 프롬프트 캐시(1h TTL). 동시성 3(세마포어), 청크 간 독립.
- 멱등키로 체크포인트 조회 → 있으면 호출 생략.
- 청크 실패(재시도 소진)는 **건너뛰고 계속**; 성공 청크 비율 < 60% → FAILED `INSUFFICIENT_COVERAGE`. 성공률은 quality에 기록.

## 7. [6] SYNTH 호출
> 2026-11-04 **세 갈래 종합**(`LLM_SYNTH_SPLIT=on` 기본, 14 §10, 13 ADR-28): 같은 공유 문맥(대화 정보·통계·전사 또는 청크 JSON·장부·관심사·사건 원문·후보)을 `cache_control: ephemeral` 블록으로 캐시하고 세 종류의 호출을 띄운다.
> ① `SYNTHESIS_SCENES` — 장(章) `moments`만. 가장 먼저 보내 프롬프트 캐시를 연다. effort `LLM_PERSONA_EFFORT`.
> ② `SYNTHESIS_VERDICT` — 판정·역학·바뀐 주·누가 먼저·둘만의 언어·발견·제안·상·점수·캡션·답·공유 카드. ①이 응답을 시작했거나 `LLM_SYNTH_STAGGER_MS`(15초)가 지나면 보낸다(캐시 적중). effort `LLM_SYNTHESIS_EFFORT`.
> ③ `SYNTHESIS_PERSONA` × N — 인물 카드 `participants`를 **2~3명씩 묶어 병렬**로. ①이 끝난 뒤 시작하며 사용자 메시지(비캐시 부분)에 `[이번 호출의 인물]`, `[이미 쓴 장(章)]`(①의 제목·등장인물·본문 앞 320자), `[이번 인물 집중 자료]`(그 사람들의 관심사 줄·팩트 장부·인용 후보를 다시 모은 것, `buildPersonaMaterial`)를 받는다. 묶음은 `batchParticipants`: 텍스트 지분 상위 8명은 `LLM_PERSONA_BATCH_SIZE`(3)명씩, 나머지는 2배씩, 호출 수가 `LLM_PERSONA_MAX_CALLS`(6)를 넘으면 묶음을 키운다. 한 호출이 8명분을 쓰면 뒤로 갈수록 흐려지던 것을 막는다. Fake 클라이언트는 `hints.batchIds`로 묶음을 흉내 낸다.
> 서버가 ①+②+③을 합쳐 `ReportDraft`로 검증한다. ①이 실패하면 그 자리에서 던져져 재시도 정책(§10)을 탄다. 각 호출은 별도 체크포인트(`report_stage_result`)라 일부만 실패해도 재시도 때 나머지는 캐시로 재사용된다. `off`면 종전처럼 `SYNTHESIS` 한 호출.
> 종합 문맥(CHUNKED): `[인물 팩트 장부]`(청크 `facts`를 사람별·시간순으로, `buildFactLedger` — 상위 8명 30개·나머지 10개, 14 §9.7), `[사람별 관심사 집계]`(청크 `signals.topics` 구간 수·`callbacks`, `buildInterestDigest`, 14 §9.6), **`[사건 원문]`**(청크 `exchanges`의 연속 메시지 2~4개를 실제 줄로, 청크당 2·총 40, `buildExchangesBlock` — 요약이 아니라 장면을 읽게), `[인물별 인용 후보 원문]`(`collectPersonaCandidates` — signals·roastMaterial·exchanges가 가리킨 그 사람 메시지, **상위 8명 25개·나머지 8개**, 2026-11-03까지는 사람당 ≤10). 사건 원문·후보·장부의 메시지는 모두 인용 허용 ID(`synthIds`)에 들어간다.
> 비용·시간(미실측 추정): 입력은 공유 문맥이 캐시 읽기(10% 단가)라 호출 수가 늘어도 +30% 안쪽, 출력 총량은 같다. 시간 ≈ ① + max(②, ③ 묶음들) — 묶음 출력이 짧아 종전 두 갈래와 비슷하거나 빠르다.
>
> (2026-11-03 두 갈래 동시 종합: `SYNTHESIS_PERSONA`(장면+인물 전원)과 `SYNTHESIS_VERDICT` 두 호출. 스트림 하나가 절반으로 짧아져 끊김 노출이 줄고 총 시간은 max(두 갈래) ≈ 종전의 60%였다. 위 세 갈래가 이를 대체한다.)

> 2026-11-04 **평가 기준은 지금**(14 §12, 13 ADR-29, 사용자 요청 "너무 옛날보다는 최신 기준으로"): `recentWindow(stats.period, REPORT_RECENT_MONTHS=6)` — 대화 전체가 9개월(= 6 × 1.5)을 넘으면 마지막 6개월이 **평가 기준 구간**이다(짧으면 null = 전체가 지금). 구간이 있으면 ① `[통계 사실]` 뒤에 `renderRecentFacts`가 "[평가 기준 구간] 최근 6개월(YYYY-MM~YYYY-MM): 메시지 N개(전체의 P%), 월평균 … 그 이전 월평균 …보다 더 바빠졌다/식었다"와 사람별 최근 지분·선톡·답장 중앙값·새벽·최근 집중 단어(전체 지분과 나란히, "최근에 더 떠든다/조용해졌다")를 붙인다(숫자는 `allowedNumbers`에 자동 등록) ② 팩트 장부·인물 인용 후보는 `sampleWithRecency`로 **상한의 절반을 최근 구간에서** 뽑고 장부 줄에 `★`를 붙인다 ③ 사건 원문은 최근 청크부터 채우고 최근 청크는 청크당 3개 ④ 하이라이트는 최근 청크 1.5배 ⑤ 관심사 집계는 `집착(전체 n, 최근 r)`로 쓰고 최근에도 나온 집착을 앞에 둔다 ⑥ 종합 문맥에 `[평가 기준]` 블록("지금"은 최근 N개월; 과거는 시간차 반전의 앞부분·전환점·반복 증명으로만; 옛 선언이 지금도 안 지켜지면 그건 최신 사실) ⑦ `ReportContent.meta.recentWindow`로 화면 머리에 "인물 평가는 최근 6개월(…) 기준" 표시. 시스템 프롬프트 화법에도 "평가 기준은 지금이다" 원칙.
- 모델 `synthesis-model`, 구조화 출력 `ReportDraft`(07 §4.2), `maxTokens 16000`, effort HIGH.
- 입력 구성: 시스템(페르소나·규칙·스키마 지침, 캐시) + 사용자 메시지:
  1. 대화 메타 + 참여자 목록(업로더 표시) + 초점·톤·질문
  2. `ChatStats` 요약(JSON, 숫자 그대로) + 결정적 "숫자 로스트 재료"(§7.1)
  3. SINGLE: 전사 전체 / CHUNKED: 청크 추출 JSON 배열 + **각 청크의 하이라이트 후보 메시지 원문**(ID 포함, 청크당 최대 25개 → 종합 단계도 실제 문장을 보고 인용)
  4. 출력 지침(한국어, JSON, 인용은 ID)

### 7.1 숫자 로스트 재료 (서버가 미리 계산해 넘기는 문장형 사실)
예: `민지(나) 선톡 71% / 지훈 29%`, `지훈 답장 중앙값 2시간 41분, 민지 4분`, `새벽 0~5시 메시지 812개 중 지훈 780개`, `최장 침묵 19일, 깬 사람 민지 "자?"(m8812)`, `ㅋ 밀도 1위 민지(메시지당 3.2개)`. LLM은 이 사실을 **그대로 인용**해 농담을 붙인다(숫자 환각 방지: 숫자 변경 금지 규칙 + 검증에서 숫자 일치 확인).

## 8. [7] VALIDATE → 필요 시 REPAIR
| 검사 | 실패 처리 |
|---|---|
| 스키마/필수 필드/배열 길이(점수 5, 발견 ≤6, 행동 3) | SDK 구조화 출력이 보장. 길이 초과는 절단, 미달은 REPAIR |
| 근거 ID 존재·전사에 포함·화자 일치(`speakerParticipantId` 명시 시) | 해당 근거 제거 |
| 발견에 유효 근거 0개 | confidence→LOW. LOW가 3개 이상이면 REPAIR 호출(해당 발견만 재작성 요청) |
| 숫자 사실 일치: 보고서 텍스트 속 숫자가 제공한 사실에 없는 값이면 | 문장 단위 플래그 → REPAIR 또는 제거 |
| 언어: `\p{IsHan}` 또는 가나 `[぀-ヿ]` 포함 | REPAIR(1회) → 재실패 시 해당 필드 제거 |
| 안전: 금지 주제 키워드(외모·보호 속성·진단명) 및 `safetyFlags` | 톤 완화 지침으로 REPAIR; 자해·학대 플래그면 액션플랜에 안내 문구 삽입 |
| 참여자 이름 정규화: 스냅샷 이름/닉네임 외 이름 등장 | 가장 가까운 참여자로 매핑 실패 시 해당 항목 제거 |
REPAIR는 종합 모델로 1회만, 원 초안 + 위반 목록을 주고 **위반 필드만** 재생성. 그 후에도 실패하면 필드 제거하고 quality에 기록.

## 9. [8] ASSEMBLE
- `evidence[].text`를 전사 원문(참여자 표시이름 적용)으로 채움, `at` 채움. 통계 비주얼용 데이터(월별, 히트맵, 답장 분포, 선톡 비율, 미디어 비율)를 `visuals`에 포함. `quality{coveragePct, mode, chunks{total,succeeded}, evidence{total,dropped}, models, tokens, costUsd, durationSec}`.
- `succeed()` CAS 업데이트. 실패 시 `fail(code, message)`; 사용자 메시지는 코드별 고정 문구(PII 없음).

## 10. 실패·재시도 매트릭스
| 상황 | 코드 | retryable | 비고 |
|---|---|---|---|
| 원문 만료 | `RAW_EXPIRED` | ✗ | 생성 요청 단계에서 409로 선차단 |
| LLM 429/5xx 지속 | `LLM_UNAVAILABLE` | ✓ | 재시도 시 체크포인트 재사용 |
| 스트림 수신 중 연결 끊김(undici `terminated`, `fetch failed`, `ECONNRESET` 등) | `LLM_UNAVAILABLE` | ✓ | 2026-11-03: 클라이언트가 네트워크 계열을 재시도(호출당 3회, cause 포함 로그)하고, 그래도 실패하면 파이프라인이 **20초 뒤 자동 재큐잉**(`attempt_count < WORKER_MAX_ATTEMPTS`; `PIPELINE_TIMEOUT` 제외). 한도에 닿으면 FAILED(사용자 "다시 시도"는 한도 때문에 거부되므로 새 보고서) |
| LLM 400(스키마/요청) | `LLM_BAD_REQUEST` | ✗ | 버그 — 알림 |
| refusal 2회 | `LLM_REFUSED` | ✗ | 사용자 문구: "이 대화는 분석할 수 없어요" |
| 커버리지 < 60% | `INSUFFICIENT_COVERAGE` | ✓ | |
| 비용 상한 | `COST_LIMIT_EXCEEDED` | ✗ | |
| 25분 초과 | `PIPELINE_TIMEOUT` | ✓ | |
| 하트비트 stale | `STALE_TIMEOUT` | 자동 재큐(attempt<3) | |
| 검증 후 필수 섹션 결손 | `VALIDATION_FAILED` | ✓ | |

## 11. 로그 규칙
- 메시지 본문·이름·질문 내용은 로그 금지. 허용: reportId, stage, chunkIndex, 토큰 수, 지연, 에러 타입, 접지 제거 수.
- LLM 원출력은 `report_stage_result`에만(24시간 후 삭제), 로그에는 길이만.
