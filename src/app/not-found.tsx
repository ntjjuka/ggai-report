import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card p-10 text-center">
      <div className="text-5xl">🗂️</div>
      <h1 className="mt-4 text-xl font-extrabold">여기엔 아무것도 없어요</h1>
      <p className="mt-2 text-sm text-muted">링크가 틀렸거나, 다른 브라우저에서 만든 대화이거나, 삭제됐을 수 있어요. 대화는 만든 브라우저에서만 열 수 있어요.</p>
      <Link href="/" className="btn-primary mt-6">
        처음으로
      </Link>
    </div>
  );
}
