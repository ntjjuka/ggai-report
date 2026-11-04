# 03. 카카오톡 대화 내보내기(.txt/.csv/.zip) 파서 명세

> 목적: 사용자가 올린 카카오톡 내보내기 파일을 **단일 정규화 모델(`ParsedChat`)** 로 변환한다.
> 파서는 의존성 없는 순수 TypeScript 모듈(`src/lib/parser`, 구현 정본)로 만들고, 골든 픽스처 테스트(`tests/parser.test.ts`)로 고정한다. `tools/spec_parser_prototype.py`는 명세 검증용 참조 구현.
> 2026-11-03 봇 발신자 규칙·업로더 선택(ADR-16/20)을 구현 기준으로 갱신.
> 조사 근거: GitHub 파서 8종(0-ki/kakaothread, hyundo32-copilot/kakaotalk-export-parser, doheon-code kakao_reply, Todari/toksai, gaoyuanshanzi/kakaotalk-chat-viewer, YeonHongMin/kakao-chat-summary, deeprine, graup) + 실제 내보내기 샘플(영문 로케일 포함).

---

## 1. 입력 유형

| 입력 | 출처 | 처리 |
|---|---|---|
| `.txt` (UTF-8, BOM 있을 수 있음) | Android/iOS/PC 공통 | 본 명세대로 파싱 |
| `.txt` 여러 개 (`Talk_2026.7.14 10:41-1.txt`, `-2.txt` …, 또는 `KakaoTalkChats-1.txt`) | iOS/구 Android 분할 저장 | 파일명 자연 정렬 → **파일별로 개별 파싱**(텍스트를 이어붙이지 않는다) → 메시지 리스트 연결 → 경계의 연속 중복 제거 |
| `.zip` | iOS "모든 메시지 도큐먼트로 저장", 직접 압축 | 내부 `.txt`/`.csv`만 추출(미디어 무시), zip 안전 검사 후 위 규칙 적용 |
| `.csv` (`Date,User,Message`) | PC(Mac) 내보내기 | CSV 파서 분기 |
| 그 외 확장자 / 바이너리 | - | `UNSUPPORTED_FILE_TYPE` 거절 |

### 1.1 크기·수량 한도 (설정값, 기본)
| 항목 | 기본 | 초과 시 에러 코드 |
|---|---|---|
| 업로드 파일 총량 | 50 MB | `FILE_TOO_LARGE` |
| zip 엔트리 수 | 2,000 | `ZIP_TOO_MANY_ENTRIES` |
| zip 해제 후 텍스트 총량 | 200 MB | `ZIP_TOO_LARGE` |
| 메시지 수 | 300,000 | `TOO_MANY_MESSAGES` |
| 화자(표시 이름) 수 | 60 | `TOO_MANY_PARTICIPANTS` |
| 최소 메시지 수 | 30 | `TOO_FEW_MESSAGES` |

zip 안전 규칙: 경로에 `..` 또는 절대경로 포함 엔트리 거절(`ZIP_UNSAFE_ENTRY`), 압축률 100배 초과 엔트리 거절(`ZIP_BOMB_SUSPECTED`), 중첩 zip 미지원.

### 1.2 인코딩 판별 순서
1. BOM 검사: `EF BB BF` → UTF-8, `FF FE` → UTF-16LE, `FE FF` → UTF-16BE
2. UTF-8 strict 디코딩 시도(`CodingErrorAction.REPORT`)
3. 실패 시 `MS949`(CP949) strict 시도 → 성공하면 `encodingFallback=true` 경고
4. 모두 실패 → `ENCODING_UNDETECTED`

줄바꿈은 `\r\n`, `\n`, `\r` 모두 정규화. 각 줄 선두 BOM(`\uFEFF`)은 제거(분할 파일 경계에서 등장).

---

## 2. 포맷 카탈로그 (실측 기반)

> 어떤 OS가 어떤 포맷을 내는지는 앱 버전마다 달라 **파일 단위로 포맷을 가정하지 않는다.** 모든 줄에 대해 아래 패턴을 순서대로 시도하는 상태 머신으로 처리하고, `sourceFormat`은 통계상 우세한 패턴으로 기록만 한다.

### 2.1 헤더 줄 (파일 상단 또는 분할 파일 경계)
```
홍길동 님과 카카오톡 대화               ← 1:1
산악회 단톡방 카카오톡 대화              ← 단체방 (「와/과 카카오톡 대화」 변형 존재)
KakaoTalk Chats AXMOS (All) (22)        ← 영문 로케일
저장한 날짜 : 2026-09-26 22:10:00       ← PC
저장한 날짜 : 2026년 9월 26일 오후 6:00  ← Android
저장한 날짜 : 2026. 5. 24. 오전 12:47    ← iOS
Date Saved : 5 October 2026 at 11:03 am ← 영문
Talk_2026.7.14 10:41-1.txt              ← iOS 분할 파일 경계 헤더
```
정규식(Java `Pattern`, 줄 전체 `^…$`):
- `HEADER_TITLE_KO`: `^(.+?)\s*(님과|와|과)?\s*카카오톡 대화\s*$`
- `HEADER_TITLE_EN`: `^KakaoTalk Chats\b.*$`
- `HEADER_SAVED_AT`: `^(저장한 날짜|Date Saved)\s*:\s*(.+)$`
- `HEADER_SPLIT_FILE`: `^(Talk_.+\.txt|KakaoTalkChats.*\.txt)$`

헤더 줄은 메시지 본문에 **절대 병합하지 않는다**(toksai 테스트 케이스 「분할 파일 경계 헤더가 직전 메시지에 붙지 않는다」). 헤더는 파일 어느 위치에서든 **줄 전체 매치**로 인식한다(iOS zip은 한 파일 안에 `Talk_…-2.txt` 헤더가 반복될 수 있다). 제목은 KO 헤더의 1그룹, EN 헤더는 `KakaoTalk Chats ` 뒤의 나머지. 프로토타입 검증에서 "현재 메시지 누적 중이면 헤더로 보지 않는다"는 조건은 **버그**였다(분할 파일 2번째 헤더가 직전 메시지에 붙음) — 조건 없이 인식한다.

### 2.2 날짜 구분선 (메시지가 아닌 줄)
```
--------------- 2026년 9월 25일 목요일 ---------------   ← PC(Windows)
2026년 9월 26일 금요일                                  ← Android/iOS
2026년 5월 11일 오후 2:19                               ← 콤마 없는 시각 구분선(스킵)
2 October 2026 at 9:02 am                               ← 영문 (콤마 없음)
```
- `DATE_SEP_DASH`: `^-{3,}\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s+[일월화수목금토]요일)?\s*-{3,}\s*$` → **현재 날짜 갱신**
- `DATE_SEP_BARE`: `^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s+[일월화수목금토]요일\s*$` → 현재 날짜 갱신
- `DATE_SEP_DOTTED`: `^(?:-{3,}\s*)?(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?(?:\s+[일월화수목금토]요일)?(?:\s*-{3,})?\s*$`
- `TIME_ONLY_KO`: `^(\d{4})년 (\d{1,2})월 (\d{1,2})일 (오전|오후) (\d{1,2}):(\d{2})$` → 스킵(날짜 갱신만)
- `TIME_ONLY_DOTTED`: `^(\d{4})\. (\d{1,2})\. (\d{1,2})\. (?:(오전|오후) )?(\d{1,2}):(\d{2})$` → 스킵
- `TIME_ONLY_EN`: `^(\d{1,2}) ([A-Z][a-z]+) (\d{4}) at (\d{1,2}):(\d{2}) (am|pm)$` → 스킵

**우세 포맷 조건(중요)**: 대시 없는 구분선(`DATE_SEP_BARE`, 대시 없는 `DATE_SEP_DOTTED`, `TIME_ONLY_*`)은 **우세 포맷이 A/B/E일 때만** 구분선으로 인식한다. 우세 포맷이 C(대괄호)이면 대시 구분선(`DATE_SEP_DASH`)만 인식한다. 이유: C 포맷에서 멀티라인 본문 2행째가 `2024년 1월 1일 월요일`처럼 생기면 날짜가 오염되어 이후 메시지 전체의 날짜가 틀어진다(픽스처 `edge_body_looks_like_date`). A/B/E에서는 각 메시지 줄이 날짜를 들고 있으므로 오인식해도 해당 메시지가 둘로 갈리는 정도의 피해에 그친다(허용).

### 2.3 메시지 줄
| 코드 | 예시 | 비고 |
|---|---|---|
| **A** 한글 장형 | `2026년 9월 26일 오후 5:40, 박팀장 : 메시지` | Android 주류 |
| **B** 점 구분 | `2025. 4. 4. 오후 11:42, 김승현 : 메시지` / 24시간제 `2026. 2. 22. 12:19, 신우 : 조식`, `2026. 2. 23. 0:05, …` | iOS/Mac. 기기 설정에 따라 12/24h 혼재 |
| **C** 대괄호 | `[김민지] [오후 8:02] 메시지` / `[김민지] [20:02] 메시지` | PC(Windows). 날짜는 2.2 구분선에서만 공급 |
| **D** CSV | `Date,User,Message` 헤더 + `2026-01-01 12:00:00,이름,"본문"` | PC(Mac). 따옴표·멀티라인 셀 |
| **E** 영문 | `2 October 2026 at 9:02 am, Won Dae Ro : 안녕하세요?` | 기기 언어 영어. 월 이름 영문 |

정규식:
- 공통 꼬리 `SEP` = `,\s(.+?)\s:(?:\s|$)([\s\S]*)$` — 발신자(lazy) + `" : "`. 본문이 비어 있으면 줄이 `" :"`로 끝날 수 있어 `(?:\s|$)`를 허용한다(→ kind `EMPTY`).
- `MSG_A`: `^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s+(?:(오전|오후)\s*)?(\d{1,2}):(\d{2})` + `SEP`
- `MSG_B`: `^(\d{4})\.\s(\d{1,2})\.\s(\d{1,2})\.\s(?:(오전|오후)\s)?(\d{1,2}):(\d{2})` + `SEP`
- `MSG_C`: `^\[(.+?)\]\s\[(?:(오전|오후)\s?)?(\d{1,2}):(\d{2})\]\s?(.*)$`
- `MSG_E`: `^(\d{1,2})\s(January|February|March|April|May|June|July|August|September|October|November|December)\s(\d{4})\sat\s(\d{1,2}):(\d{2})\s(am|pm)` + `SEP`
- 발신자/본문 구분자는 **첫 번째 `" : "`(공백-콜론-공백)** 만 사용한다. 본문에 `3 : 30` 같은 콜론이 있어도 안전(toksai 테스트, 픽스처 `edge_colon_in_body`).
- 발신자 이름에는 공백·이모지·괄호·대괄호가 올 수 있다(`이마따전 🤯⚒️💙`, `이동훈(Donghun)`). `MSG_C`의 `(.+?)` lazy 매칭은 `] [시각]` 패턴에서 멈추므로 이름 안의 `]`도 처리된다.

### 2.4 시스템 줄
포맷 A/B/E에서는 **콤마는 있으나 `" : "`가 없는 줄**, 포맷 C에서는 **대괄호 없이 나타나는 줄**이다. 열거 패턴은 분류(kind)용이고, 열거에 없는 것도 「날짜+콤마 있음, 구분자 없음」 규칙으로 SYSTEM_OTHER 처리하여 **본문에 섞이지 않게** 한다.
```
홍길동님이 들어왔습니다.                SYSTEM_JOIN
홍길동님이 나갔습니다.                  SYSTEM_LEAVE
홍길동님이 채팅방을 나갔습니다.          SYSTEM_LEAVE
홍길동님이 김철수님, 이영희님을 초대했습니다.  SYSTEM_INVITE
홍길동님을 내보냈습니다.                SYSTEM_KICK
메시지가 삭제되었습니다. / 삭제된 메시지입니다. / The message has been deleted.   DELETED (발신자 유지)
Won Dae Ro invited A, B and C.          SYSTEM_INVITE (영문)
X joined this chatroom. / X left.       SYSTEM_JOIN / SYSTEM_LEAVE (영문, 실측 미확정 → 패턴 미스여도 SYSTEM_OTHER)
```
- `SYS_JOIN`: `^(.{1,60}?)님이 들어왔습니다\.?$`
- `SYS_LEAVE`: `^(.{1,60}?)님이 (채팅방을 )?나갔습니다\.?$`
- `SYS_INVITE`: `^(.{1,60}?)님이 (.+?)님을 초대했습니다\.?$`
- `SYS_KICK`: `^(.{1,60}?)님을 내보냈습니다\.?$`
- `SYS_INVITE_EN`: `^(.+?) invited (.+)\.$` · `SYS_JOIN_EN`: `^(.+?) joined( this chatroom)?\.$` · `SYS_LEAVE_EN`: `^(.+?) left( this chatroom)?\.$` (영문 join/leave 문구는 실측 미확정 — 미스여도 SYSTEM_OTHER로 안전)
- `DELETED_MARKER`: `^(메시지가 삭제되었습니다\.|삭제된 메시지입니다\.|The message has been deleted\.)$` — 메시지 본문으로 오면 발신자 유지 + kind `DELETED`, 날짜 없는 단독 줄(영문 포맷)로 오면 발신자 null + 직전 메시지 시각.
- 발신자가 카카오톡 시스템 봇 이름(`오픈채팅봇`·`오픈채팅 봇`·`채팅봇`·`플레이봇`·`카카오톡 채팅봇`, 또는 `^(카카오톡 )?(오픈)?(채팅|플레이) ?봇$` — 구현 `patterns.ts isBotSender`)이면 본문과 무관하게 kind=`BOT`. 참여자 행은 `is_bot=true`로 만들고 위저드에서 기본 제외(해제 가능), 통계·전사에서 제외

### 2.5 미디어/특수 본문 (본문이 아래와 **정확히** 일치할 때만 분류, 그 외는 TEXT)
| 본문 | kind |
|---|---|
| `사진`, `사진 N장` (`^사진( \d{1,2}장)?$`), `<사진 읽지 않음>` | PHOTO |
| `동영상`, `<동영상 읽지 않음>` | VIDEO |
| `이모티콘`, `(이모티콘)` | EMOTICON |
| `음성메시지` | VOICE |
| `파일: {파일명}` (`^파일:\s*(.+)$`) | FILE (fileName 보관) |
| `지도`, `연락처` | MAP / CONTACT |
| 영문 `Photo`, `Video`, `Emoticon`, `Voice message`, `File: …` | 동일 분류 (실측 미확정, 베스트에포트) |
| `삭제된 메시지입니다.` 등 | DELETED |
| `샵검색: …`, `톡게시판 '공지': …`, `송금 …`, `통화 시간 …` | TEXT (원문 유지, `special=true` 플래그만) |

본문 내 URL(`https?://\S+`) → `hasLink=true`, `@이름` 멘션 → `mentions[]` 추출(통계용).

---

## 3. 상태 머신 (줄 단위)

```
입력: 파일 1개의 디코딩된 텍스트(파일별로 호출), fmt = detectFormat(첫 1,000줄)
state: curDate(LocalDate|null), cur(MessageBuilder|null), warnings
for line in lines:                       # \r\n, \r 정규화 후
  line = stripLeadingBOM(line); s = line.strip()
  1. HEADER_*(s) 매치                      → flush(cur); 제목 추출; continue   (cur 상태와 무관하게 인식)
  2. DATE_SEP_DASH(s) 매치                 → flush(cur); curDate = …; continue
  3. fmt ∈ {A,B,E} 인 경우에만:
       DATE_SEP_BARE | DATE_SEP_DOTTED(s) → flush(cur); curDate = …; continue
       TIME_ONLY_KO|DOTTED|EN(s)          → flush(cur); curDate = …; continue
  4. MSG_A | MSG_B | MSG_E (line) 매치     → flush(cur); curDate = 날짜; cur = new(dt, sender, [body]); continue
  5. SYS_A | SYS_B | SYS_E (line) 매치     → flush(cur); emit SYSTEM(dt, text, kind=classifySystem); continue
     (날짜접두 + ", " 있으나 " : " 없음)
  6. MSG_C(line) 매치:
       curDate != null                    → flush(cur); cur = new(curDate+시각, sender, [body]); continue
       curDate == null                    → warnings.dateUnknownBeforeSeparator++; continue (메시지 폐기)
  7. SYS_JOIN|LEAVE|INVITE|KICK|*_EN | DELETED_MARKER (s) 매치   # 날짜·대괄호 없는 단독 시스템 줄
                                          → flush(cur); emit SYSTEM(at=직전 메시지 시각 or curDate 00:00); continue
  8. s 비어 있음                           → cur != null 이면 cur.body += ""(빈 줄 보존); continue
  9. 그 외                                 → cur != null 이면 cur.body += line (멀티라인), 아니면 warnings.orphanLines++
end: flush(cur)
flush: body = join("\n").strip() → classify(2.5) → isBotSender(sender) 이면 BOT → emit
```
이 순서는 `docs/tools/spec_parser_prototype.py`(명세의 Python 참조 구현)로 13개 픽스처 전부에 대해 검증했다. Java 구현은 같은 입력에 대해 `fixtures/*.expected.json`과 동일한 결과를 내야 한다.
- `flush`: 본문 trim 후 kind 분류(2.5), 빈 본문이면 `EMPTY` kind로 보존(통계 제외).
- 12시간제 변환: `오전 12 → 0`, `오후 12 → 12`, `오후 N(1~11) → N+12`, `오전 N → N`; 영문 `am/pm` 동일.
- 타임존: 내보내기에는 TZ·초 정보가 없다. `LocalDateTime`(분 해상도)으로 저장하고 보고서 표기는 `Asia/Seoul` 가정. 답장 속도 계산은 분 해상도임을 통계 문서에 명시.
- 시간 역행(분할 파일 병합·기기 시계 변경): 순서를 바꾸지 않고 `warnings += NON_MONOTONIC_TIMESTAMP(count)`.
- 분할 파일 경계 중복: 파일별 파싱 결과를 연결한 뒤 `(dateTime, sender, body)` 가 **연속으로 동일**한 메시지는 1개로 축약(`dedupedCount` 기록). 연결 후 `index`를 0부터 다시 매긴다.

### 3.1 포맷 자동 감지 (`sourceFormat` 보고용)
첫 1,000줄에서 각 MSG_* 매치 수를 세어 최다 패턴을 `KAKAO_ANDROID_KO(A) | KAKAO_IOS_DOTTED(B) | KAKAO_PC_BRACKET(C) | KAKAO_CSV(D) | KAKAO_EN(E)`로 기록. 첫 비공백 줄이 CSV 헤더(`^"?date"?\s*,\s*"?user"?\s*,\s*"?message"?$`, 대소문자 무시)면 D로 분기. 어떤 패턴도 0건이면 `NO_MESSAGES`. 우세 포맷은 §2.2의 '대시 없는 구분선 인식 여부'를 결정한다.

### 3.2 CSV(D) 규칙
RFC4180 준수 파서(따옴표 이스케이프 `""`, 셀 내 줄바꿈 허용). 열 인덱스는 헤더 이름으로 찾는다. 날짜 `^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?`. 시스템/미디어 분류는 본문 규칙(2.4~2.5) 공통 적용.

---

## 4. 출력 모델

```java
record ParsedChat(
    String title,                 // 헤더에서 추출, 없으면 null
    SourceFormat sourceFormat,
    List<Message> messages,       // 시간순(원본 순서), index = 0..n-1
    List<ParticipantSummary> participants, // rawName, messageCount, firstAt, lastAt (등장 순)
    LocalDateTime startedAt, LocalDateTime endedAt,
    ParseWarnings warnings        // encodingFallback, orphanLines, nonMonotonic, deduped, unknownSystemLines
) {}

record Message(int index, LocalDateTime at, String sender /*null if system*/, MessageKind kind,
               String text /*TEXT/DELETED/SYSTEM 원문*/, String fileName, boolean hasLink, List<String> mentions) {}

enum MessageKind { TEXT, PHOTO, VIDEO, EMOTICON, VOICE, FILE, MAP, CONTACT, DELETED, EMPTY,
                   SYSTEM_JOIN, SYSTEM_LEAVE, SYSTEM_INVITE, SYSTEM_KICK, SYSTEM_OTHER, BOT }
```
- `index`는 LLM 프롬프트의 메시지 ID(`m{index}`)로 쓰이므로 **파싱 결과가 결정적(deterministic)** 이어야 한다(같은 입력 → 같은 index).
- 통계·LLM 입력에는 `TEXT`, `DELETED`(존재만), 미디어(종류만) 를 쓰고 `SYSTEM_*`는 참여/이탈 이벤트로만 쓴다.

---

## 5. 참여자 처리 (파서 밖, 서비스 계층)
1. **"나" 식별**: 카카오톡은 업로더를 표시하지 않는다 → 위저드 참여자 단계에서 "이게 나예요"로 선택(**선택 사항**, ADR-16). 미지정이면 전사에 `(나)` 표식이 없고 프롬프트가 분기한다.
2. **이름 변경 병합**: 같은 사람이 표시 이름을 바꾸면 두 이름으로 나타난다. 1:1(이름 3개 이상 감지) 시 toksai 알고리즘(화자 교대 가중치 기반 2분할 + 최근 활동 대표 이름) 으로 **제안**만 하고 사용자가 확인. 단체방은 제안 없이 수동 병합 UI.
3. **제외**: 봇·공지 계정·분석 제외 대상은 사용자가 체크.
4. 저장: `participant(raw_name, display_name, merged_into_id, excluded, is_uploader)`.

---

## 6. 에러 코드 (파서 → API 400/422 매핑)
| code | HTTP | 메시지(사용자용) |
|---|---|---|
| `UNSUPPORTED_FILE_TYPE` | 400 | txt, csv, zip 파일만 올릴 수 있어요 |
| `FILE_TOO_LARGE` | 413 | 파일이 너무 커요 (최대 50MB) |
| `ENCODING_UNDETECTED` | 422 | 파일 인코딩을 읽을 수 없어요. 카카오톡에서 다시 내보내 주세요 |
| `NO_MESSAGES` | 422 | 대화 메시지를 찾지 못했어요. 카카오톡 "대화 내보내기" 파일인지 확인해 주세요 |
| `TOO_FEW_MESSAGES` | 422 | 메시지가 30개 미만이라 분석할 수 없어요 |
| `TOO_MANY_MESSAGES` | 422 | 메시지가 너무 많아요 (최대 30만 개) |
| `TOO_MANY_PARTICIPANTS` | 422 | 참여자가 너무 많아요 (최대 60명) |
| `ZIP_*` | 422 | 압축 파일을 처리할 수 없어요 |

---

## 7. 테스트 픽스처 (docs/fixtures → src/test/resources/fixtures 로 복사)
모두 **가상 인물·가상 내용**으로 작성한다. 실제 대화 파일은 저장소에 넣지 않는다.

| 파일 | 포맷 | 검증 포인트 (프로토타입 검증 결과) |
|---|---|---|
| `android_ko_basic.txt` | A | 헤더 2줄, bare 날짜 구분선, 멀티라인, `사진`/`이모티콘`/`파일:`, 콤마형 시스템(초대/나갔습니다), `삭제된 메시지입니다.`(발신자 유지), `오후 11:58→23:58`, `오전 12:19→00:19`, `오후 12:00→12:00`, 본문 `3 : 30` 보존 → 16개 메시지 |
| `cp949.txt` | A | 위 파일의 CP949 인코딩 → 동일 결과 + `encodingFallback=true` |
| `ios_dotted_12h.txt` | B | 분할 헤더 `Talk_…-1/2.txt`+`저장한 날짜` 반복(한 파일 안), BOM, 빈 줄 포함 멀티라인 보존, 경계 중복 1건 제거(`dedupedCount=1`), 이모지 이름 |
| `ios_dotted_24h.txt` | B | `12:19`, `23:45`, `0:05` 24시간제, URL `hasLink`, `@멘션` |
| `pc_bracket.txt` | C | `---- 날짜 요일 ----`, `[이름] [오후 8:02]`, `[이름] [20:30]`, 대괄호 없는 시스템 줄 2종, `파일:`, `동영상`, 이름에 `[별명]` 포함(`박산행 [별명]`) |
| `pc_csv.csv` | D | 따옴표 이스케이프 `""`, 쉼표, 셀 내 줄바꿈, 초 포함 시각, URL |
| `en_android.txt` | E | `KakaoTalk Chats …` 제목, `Date Saved`, bare 영문 시각 줄 스킵, `invited … and …`→SYSTEM_INVITE, 단독 `The message has been deleted.`→DELETED(발신자 null), `Photo`, `12:00 am→00:00`, `12:30 pm→12:30` |
| `mixed_split_merge/` (2파일) | A | 파일별 파싱 후 연결, 경계 중복 1건 제거, 시간 역행 1건 경고(`nonMonotonicTimestamp=1`) |
| `group_30people.txt` | A | 참여자 30명 + 초대/퇴장, `오픈채팅봇`→BOT(`is_bot`, 기본 제외), 멘션·링크 |
| `edge_colon_in_body.txt` | A | `시간은 3 : 30이야`, `ㅇㅋ : )`, 빈 본문(`… 곽민성 : `)→EMPTY |
| `edge_body_looks_like_date.txt` | C | 멀티라인 2행째 `2024년 1월 1일 월요일`이 **구분선으로 오인되지 않음**(우세 포맷 조건), 3개 메시지 날짜 정상 |
| `empty_or_garbage.txt` | - | `NO_MESSAGES` |

기대값은 `fixtures/<이름>.expected.json`(프로토타입 `--write-expected`로 생성, 사람이 검토). Java 구현의 골든 테스트는 이 JSON과 필드 단위로 동일해야 한다(`at`은 `yyyy-MM-dd'T'HH:mm`). 파서 변경 시 diff로 회귀 검출한다.

---

## 8. 성능 목표
- 50MB(약 100만 줄) 파일: 단일 패스, 스트리밍 라인 리더, 20초 이내, 힙 1GB 이내(메시지 객체 30만 개 상한).
- 정규식은 `Pattern` 정적 상수로 1회 컴파일. 줄당 패턴 시도 순서는 매치 빈도 높은 MSG_A/B/C를 헤더/구분선 다음에 둔다(헤더·구분선은 희소하나 **먼저 걸러야** 오병합을 막는다).

## 부록 C. 데이터 덩어리 메시지 → `DATA` (2026-11-03)
실측: 파일·이미지가 헥스 문자열로 들어온 메시지, 해시·base64·로그 덤프가 "가장 긴 메시지"·장문파 뱃지·평균 길이를 독식했다. `patterns.isBlobLike()`가 아래 중 하나면 본문을 `DATA`로 분류한다(첨부처럼 개수만 세고 텍스트 통계·전사에서 제외, `media.other`에 합산):
- 32자 이상 헥스 연속이 있고 비공백 문자의 60% 이상이 헥스 문자
- 한글이 없고 60자 이상의 불투명 토큰(base64·토큰)이 있음 — URL은 제외
- 비공백 120자 이상인데 글자(한글+라틴)가 40% 미만(숫자·기호 위주 로그·좌표·표)
40자 미만은 항상 텍스트. 파서(`classifyBody`)에서 새 업로드에 적용하고, 이미 `TEXT`로 저장된 구버전 대화는 `toEffectiveMessages`가 런타임에 같은 판정으로 `DATA`로 바꾼다(재업로드 불필요).
