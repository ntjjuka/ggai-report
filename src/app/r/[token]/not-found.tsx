import Link from "next/link";

const PERSONA = process.env.PERSONA_NAME ?? "까비서";

/** 공유 링크 전용 404 — 쿠키·브라우저와 무관하다는 걸 분명히 한다(전역 not-found 문구는 소유자 페이지용) */
export default function SharedNotFound() {
  return (
    <div className="card p-10 text-center">
      <div className="text-5xl">🔗</div>
      <h1 className="mt-4 text-xl font-extrabold">이 공유 링크는 더 열리지 않아요</h1>
      <p className="mt-2 text-sm text-muted">
        보고서 주인이 공유를 끄거나 링크를 새로 만들었거나, 보고서가 삭제됐어요. 주소를 잘못 옮겨 적은 건 아닌지도 확인해 보세요.
        <br />
        공유 링크는 로그인·쿠키 없이 누구나 열 수 있어서, 다른 컴퓨터나 휴대폰이라서 안 보이는 건 아니에요. 주인에게 새 링크를 받으면 돼요.
      </p>
      <Link href="/setup" className="btn-primary mt-6">
        내 카톡도 {PERSONA}한테 보여주기
      </Link>
    </div>
  );
}
