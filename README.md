# 까비서 (ggai-report)

카카오톡 대화 내보내기 파일을 올리면 AI 페르소나 「까비서」(까다+비서, 반말)가 끝까지 읽고 **솔직하고 웃긴, 근거 있는 보고서**를 써주는 서비스. [What Brandon Thinks](https://www.whatbrandonthinks.com)의 카카오톡·한국어 카피본.

- 설계 문서: [`docs/00-README.md`](docs/00-README.md) (조사 → 요구사항 → 파서 명세 → 아키텍처 → 데이터 → API → 보고서/프롬프트 → 파이프라인 → UX → 보안 → 테스트 → 구현 계획 → ADR → 화법 가이드 → 스택 재검토 → 실측 흐름)
- 스택: Next.js 16 (App Router) · TypeScript · PostgreSQL 16 · pg-boss(큐) · drizzle · Anthropic SDK(Claude) · Tailwind v4 · Vitest

## 흐름
1. `/setup` 위저드 7단계: 대화 유형 → 앱 → 업로드(즉시 파싱 + 메시지 수 + 신호 등급) → 참여자 확인(프로필 합치기·제외·나 선택) → 이름 정리 → 언어 → 보고서 만들기
2. `/c/{id}/story` 통계 스토리 7장 (Tier 0, LLM 없음, 즉시): 한눈에 · 누가 더 많이, 누가 먼저 · 대화의 리듬 · 가장 긴 메시지 · 모든 건 여기서 시작 · 그리고 지금, 여기까지 · 자주 쓰는 말
3. `/c/{id}/reports/{seq}` 까비서 보고서: 결론 보고(판정) → 진짜 역학 → 변동 보고(바뀐 주) → 누가 먼저 치고 누가 아닌 척하는지 → 둘만의 언어와 반복되는 농담 → 인물별 의견 → 발견 → 비서 제안 3건(내가 너라면) → 이달의 상 → 점수 → 검증된 순간 → 숫자로 보는 우리 → 질문 답 → 공유 카드
4. `/r/{token}` 공유 페이지 + `/r/{token}/card.png` 공유 카드 이미지

## 로컬 실행 (Docker, Windows 기준)
사전 준비: Docker Desktop(WSL2 백엔드)이 실행 중이고 Git이 설치돼 있으면 됩니다. Node는 없어도 됩니다(빌드는 컨테이너 안에서 합니다).

```powershell
cd D:\work
git clone https://github.com/ntjjuka/ggai-report.git
cd ggai-report
git checkout docs/design-v1
Copy-Item .env.example .env
```

`.env`에서 두 값만 채우면 됩니다.
- `APP_CRYPTO_KEY`: 32바이트 base64. PowerShell에서 생성:
  ```powershell
  [Convert]::ToBase64String((1..32 | ForEach-Object { [byte](Get-Random -Maximum 256) }))
  ```
  (Node가 있으면 `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
- `ANTHROPIC_API_KEY`: 아래 "LLM(Claude) 키 등록" 참고. 예시 파일은 `LLM_PROVIDER=fake`(가짜 보고서)로 시작하므로 키 없이도 흐름을 볼 수 있습니다.

완성된 `.env`의 핵심 줄은 이렇게 생겨야 합니다. `=` 뒤에 값만 두고, 같은 줄에 주석이나 따옴표를 넣지 마세요(Compose가 값으로 읽습니다).
```
APP_CRYPTO_KEY=vsLohOjkLgMEeRBrMgtXBTWFdt799og6DmjQcY2Lpfk=
LLM_PROVIDER=fake
ANTHROPIC_API_KEY=
```

```powershell
docker compose up --build
```
첫 빌드는 이미지 다운로드 + `pnpm install` + `next build` 때문에 5~10분 걸립니다. 로그에 `web-1 … Ready` 가 보이면 http://localhost:3000 을 엽니다. 워커가 먼저 마이그레이션을 적용하고 준비 파일을 만든 뒤에 web이 뜹니다.

- 백그라운드 실행: `docker compose up -d --build` · 로그: `docker compose logs -f worker web` · 중지: `docker compose down`(DB 데이터 유지) · 완전 초기화: `docker compose down -v`
- 코드나 `.env`를 바꿨으면 `docker compose up -d --build` 로 다시 띄웁니다. `.env`만 바꿨으면 `docker compose up -d --force-recreate worker web`.
- 업데이트를 한 번에: `powershell -ExecutionPolicy Bypass -File scripts\update.ps1` (git pull → 빌드·기동 → 상태·로그 출력, 휴대폰용 주소 안내). 휴대폰으로 열 때는 같은 와이파이에서 PC의 IPv4 주소로 접속하고, 안 열리면 Windows 방화벽에서 3000 포트를 허용합니다. 보고서 목록은 브라우저(쿠키)별이라 휴대폰에서 올린 대화만 휴대폰에서 보입니다.
- 바인드 마운트가 없어서 Docker Desktop 파일 공유 설정은 필요 없습니다. DB는 named volume `pgdata`에 남습니다.

### 안 될 때
| 증상 | 원인 | 조치 |
|---|---|---|
| `env file .env not found` | `.env`를 만들지 않음 | `Copy-Item .env.example .env` 후 값 채우기 |
| `worker-1 … [worker] fatal: Error: APP_CRYPTO_KEY 는 base64로 인코딩된 32바이트 키여야 합니다` 뒤에 `dependency failed to start: container ggai-report-worker-1 is unhealthy` | `.env`의 `APP_CRYPTO_KEY=` 뒤가 비어 있거나(옛 예시 파일은 같은 줄의 주석이 값으로 읽혔음) 32바이트 base64가 아님 | `.env`에서 그 줄을 `APP_CRYPTO_KEY=<생성한 키>` 한 줄로만 두고(주석·따옴표 없이) `docker compose up` 다시 실행. 재빌드 불필요 |
| `Bind for 0.0.0.0:3000 failed: port is already allocated` | 3000번을 다른 프로그램이 사용 | `.env`에 `WEB_PORT=3100` 과 `APP_BASE_URL=http://localhost:3100` 추가 |
| 빌드 중 `exit code 137` / `Killed` | 메모리 부족 | Docker Desktop → Settings → Resources 메모리 4GB 이상 |
| 업로드는 되는데 다음 화면이 404 | 쿠키가 버려짐 | 수정됨: `APP_BASE_URL`이 `https://`일 때만 Secure 쿠키. LAN IP(http://192.168…)로 열어도 됩니다 |
| Git Bash에서 `scripts/smoke.sh` 가 `\r` 오류 | CRLF로 체크아웃 | `.gitattributes`로 LF 고정됨. 이전 클론이면 `git add --renormalize .` 후 다시 체크아웃 |
| 첫 접속에서 500 | 마이그레이션 전에 web이 뜸 | 수정됨: web은 worker healthcheck(준비 파일)가 통과한 뒤 시작 |
| `corepack` 다운로드 프롬프트에서 멈춤 | pnpm 버전 내려받기 확인 | 수정됨: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` |
| 보고서가 `LLM_BAD_REQUEST`로 실패, 워커 로그에 `The compiled grammar is too large` | 종합 단계의 구조화 출력 스키마가 API 문법 한도를 넘음 | 수정됨: 종합 단계는 JSON 모드(스키마를 프롬프트에 첨부, 서버에서 zod 검증)로 호출 |
| 보고서가 `LLM_BAD_REQUEST`로 실패, 로그에 `401` / `authentication_error` | `ANTHROPIC_API_KEY`가 틀리거나 비어 있음 | `.env`의 키 확인 후 `docker compose up -d --force-recreate worker` |
| 보고서가 `LLM_BAD_REQUEST`로 실패, 로그에 `credit balance is too low` | Console 크레딧 부족 | console.anthropic.com → Billing 에서 충전 |
| 보고서가 `LLM_MAX_TOKENS`(보고서가 너무 길어져서 멈췄어요)로 실패 | 모델의 사고(thinking) 토큰이 출력 한도(16k)를 먹어 JSON이 잘림 | 수정됨: 스트리밍 수신 + 출력 한도 상향(청크 32k·종합 64k·수리 24k). 실패한 보고서는 "다시 시도" |
| 새 보고서를 만들면 `이미 만들고 있는 보고서(No.N)가 있어요` | 워커 재시작·배포 중에 만들던 보고서가 QUEUED/RUNNING으로 남음 | 수정됨: 워커 기동 시 자동 복구 + 새 보고서 요청 시 죽은 보고서(하트비트 10분 끊김)는 web이 직접 정리. 그래도 나오면 실제로 진행 중인 것이니 대화 페이지 배너 → "진행 상황 보기" → "너무 오래 걸리면 취소하기". 배포 뒤에는 **web과 worker를 모두** 다시 빌드할 것(`docker compose up -d --build`) |

멈춘 보고서를 손으로 정리하려면(워커가 멈춘 상태에서만):
```powershell
docker compose exec postgres psql -U ggai -d ggai -c "UPDATE report SET status='CANCELED', finished_at=now(), updated_at=now(), progress_message='취소됨' WHERE status IN ('QUEUED','RUNNING');" -c "DELETE FROM pgboss.job WHERE name='report-generate' AND state IN ('created','active','retry');"
```

E2E 확인(선택, Git Bash): 서버가 떠 있는 상태에서 `BASE_URL=http://localhost:3000 bash scripts/smoke.sh`. 기본 픽스처는 메시지 304개짜리라 기본 한도(최소 30개)에서도 통과합니다.

## 개발 실행 (Docker 없이)
PostgreSQL 16이 떠 있어야 합니다. `.env`의 `DATABASE_URL`을 맞춘 뒤:
```bash
pnpm install
```
```bash
pnpm db:migrate
```
```bash
pnpm dev
```
```bash
pnpm worker
```

## 테스트
```bash
pnpm test
```
단위(파서 골든 픽스처 13파일·기대값 12종, 통계, 보고서 검증·어셈블, 프롬프트) + 통합(실제 PostgreSQL `ggai_test` + 가짜 LLM, `.env.test`). 서버를 띄운 상태에서 E2E 스모크:
```bash
pnpm smoke
```

## LLM(Claude) 키 등록
보고서 본문은 Claude가 씁니다(통계 스토리는 LLM 없이 나옵니다). 키는 **워커만** 씁니다. web 컨테이너는 LLM을 호출하지 않습니다.

1. 키 발급: [Anthropic Console](https://console.anthropic.com) → API Keys → Create Key. 결제 수단(선불 크레딧)이 등록돼 있어야 호출이 됩니다. 키(`sk-ant-…`)는 생성 직후 한 번만 보여주니 바로 복사하세요.
2. `.env`에 넣기 (파일은 `.gitignore`에 있어 커밋되지 않습니다):
   ```
   LLM_PROVIDER=anthropic
   ANTHROPIC_API_KEY=sk-ant-여기에_붙여넣기
   LLM_SYNTHESIS_MODEL=claude-opus-5-5
   LLM_CHUNK_MODEL=claude-sonnet-5-5
   LLM_FALLBACK_MODEL=claude-opus-4-8
   LLM_MAX_COST_USD=5
   ```
3. 적용: 워커만 다시 띄우면 됩니다.
   ```bash
   docker compose up -d --force-recreate worker
   ```
4. 확인: 대화를 올리고 보고서를 만든 뒤 워커 로그를 봅니다. `[worker] started · provider=anthropic` 이 보여야 하고, 키가 틀리면 보고서가 `LLM_BAD_REQUEST`(401)로 실패합니다.
   ```bash
   docker compose logs -f worker
   ```
   Docker 없이 빠르게 보려면 `LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=… pnpm eval docs/fixtures/group_30people.txt` 로 보고서 1건을 만들어 검증 지표와 비용을 출력할 수 있습니다(실제 과금).
5. 비용·안전
   - 단가(2026-10 기준, 입력/출력 1M 토큰): Opus 5.5 $4/$20, Sonnet 5.5 $2/$10. 메시지 1만 개(약 30만 토큰) 단일 패스 보고서 1건 ≈ $1.5, 10만 개(월별 청크 + 종합) ≈ $7~10.
   - `LLM_MAX_COST_USD`는 보고서 1건의 예상 비용 상한입니다. 넘으면 샘플링(커버리지 < 100%)하거나 `COST_LIMIT_EXCEEDED`로 거절합니다. Console의 월 지출 한도(Spend limit)도 같이 걸어 두세요.
   - 키가 새면 Console에서 즉시 폐기(Disable)하고 새로 발급합니다. 키를 코드·문서·이슈에 붙여넣지 마세요.
   - 모델을 바꾸려면 `LLM_*_MODEL`만 바꾸면 됩니다. 단가표는 `src/lib/llm/cost.ts`에 있고, 표에 없는 모델은 Opus 5 단가로 계산합니다.
   - 쓴 돈 확인: 보고서 하단(소유자에게만)에 건당 비용·토큰이 나오고, 누적은 `docker compose exec postgres psql -U ggai -d ggai -c "SELECT round(sum(cost_usd)::numeric, 2) AS usd, count(*) AS calls FROM llm_call_log;"` 로 봅니다. Console의 Usage 페이지가 정확한 기준입니다.
   - 개인용(프로모션 크레딧)이라 긴 대화도 전부 읽게 하려면 `.env`에 `LLM_MAX_COST_USD=20`, `LLM_MAX_TOTAL_TOKENS=6000000`을 둡니다. 10만 메시지 전량 ≈ $10(Sonnet 읽기) 또는 ≈ $2.5(`LLM_CHUNK_MODEL=claude-haiku-5-5`).

## 환경 변수
`.env.example` 참고. 핵심: `DATABASE_URL`, `APP_CRYPTO_KEY`(32바이트 base64), `LLM_PROVIDER`(anthropic|fake), `ANTHROPIC_API_KEY`, `LLM_SYNTHESIS_MODEL`(기본 claude-opus-5-5), `LLM_CHUNK_MODEL`(기본 claude-sonnet-5-5), `PERSONA_NAME`(기본 까비서), `RAW_RETENTION_DAYS`(기본 7).

## 구조
```
src/lib/parser   카카오톡 내보내기 파서 (Android/iOS/PC/CSV/영문)      docs/03
src/lib/stats    결정적 통계·점수 prior·숫자 사실                      docs/08 §3
src/lib/tier0    통계 스토리 7장·뱃지·어워드·템플릿                     docs/15 §B.4, docs/17
src/lib/report   보고서 스키마(zod)·전사·플래너·검증기·어셈블러          docs/07, docs/08
src/lib/llm      Anthropic/Fake 클라이언트·프롬프트·단가                docs/07 §5·§7
src/server       설정·DB(drizzle)·암호화·큐(pg-boss)·서비스·HTTP 공통    docs/04, docs/05, docs/06
src/worker       파이프라인·워커 엔트리                                 docs/08
src/app          Next 페이지·API 라우트                                docs/06, docs/09
db/migrations    SQL 마이그레이션 (새 버전 파일로만 변경)              docs/05
docs/fixtures    파서 골든 픽스처 + 기대값
```

## 라이선스 고지
- 폰트 Pretendard (SIL OFL 1.1) — `public/fonts/LICENSE-Pretendard.txt`
