# 까비서 (ggai-report)

카카오톡 대화 내보내기 파일을 올리면 AI 페르소나 「까비서」(까다+비서, 반말)가 끝까지 읽고 **솔직하고 웃긴, 근거 있는 보고서**를 써주는 서비스. [What Brandon Thinks](https://www.whatbrandonthinks.com)의 카카오톡·한국어 카피본.

- 설계 문서: [`docs/00-README.md`](docs/00-README.md) (조사 → 요구사항 → 파서 명세 → 아키텍처 → 데이터 → API → 보고서/프롬프트 → 파이프라인 → UX → 보안 → 테스트 → 구현 계획 → ADR → 화법 가이드 → 스택 재검토 → 실측 흐름)
- 스택: Next.js 16 (App Router) · TypeScript · PostgreSQL 16 · pg-boss(큐) · drizzle · Anthropic SDK(Claude) · Tailwind v4 · Vitest

## 흐름
1. `/setup` 위저드 7단계: 대화 유형 → 앱 → 업로드(즉시 파싱 + 메시지 수 + 신호 등급) → 참여자 확인(프로필 합치기·제외·나 선택) → 이름 정리 → 언어 → 보고서 만들기
2. `/c/{id}/story` 통계 스토리 7장 (Tier 0, LLM 없음, 즉시): 한눈에 · 누가 더 많이, 누가 먼저 · 대화의 리듬 · 가장 긴 메시지 · 모든 건 여기서 시작 · 그리고 지금, 여기까지 · 자주 쓰는 말
3. `/c/{id}/reports/{seq}` 까비서 보고서: 결론 보고(판정) → 진짜 역학 → 변동 보고(바뀐 주) → 누가 먼저 치고 누가 아닌 척하는지 → 둘만의 언어와 반복되는 농담 → 인물별 의견 → 발견 → 비서 제안 3건(내가 너라면) → 이달의 상 → 점수 → 검증된 순간 → 숫자로 보는 우리 → 질문 답 → 공유 카드
4. `/r/{token}` 공유 페이지 + `/r/{token}/card.png` 공유 카드 이미지

## 로컬 실행 (Docker)
```bash
cp .env.example .env
```
`.env`에서 `APP_CRYPTO_KEY`(아래 명령으로 생성)와 `ANTHROPIC_API_KEY`를 채웁니다. LLM 없이 먼저 돌려보려면 `LLM_PROVIDER=fake`.
```bash
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```
```bash
docker compose up --build
```
http://localhost:3000 접속. 워커가 시작할 때 마이그레이션을 적용합니다.

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
