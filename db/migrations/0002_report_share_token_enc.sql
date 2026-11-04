-- docs/05 §3·§6, docs/13 ADR-27 (2026-11-04)
-- 공유 토큰 원문을 AES-256-GCM(APP_CRYPTO_KEY, AAD = report.id)으로 암호화해 보관한다.
-- 이전에는 해시만 저장하고 원문은 프로세스 메모리 캐시에만 있어서, 페이지를 새로 고치거나 배포로 web이 재시작되면
-- 보고서 화면에서 링크가 사라지고 "새 공유 링크 만들기"만 남았다 → 누르면 새 토큰이 발급되어 이미 보내 준 링크가 404가 됐다.
-- 조회(/r/{token})는 여전히 share_token_hash로 한다. 이 컬럼은 소유자 화면에 같은 링크를 다시 보여 주기 위한 것.
ALTER TABLE report ADD COLUMN share_token_enc BYTEA;
