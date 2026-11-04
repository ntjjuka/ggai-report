import Link from "next/link";
import { readOwner } from "@/server/owner";
import { listOwnedConversations } from "@/server/services/conversations";

export const dynamic = "force-dynamic";
export const metadata = { title: "내 보고서", robots: { index: false } };

const STATUS_LABEL: Record<string, string> = { QUEUED: "줄 서는 중", RUNNING: "작성 중", SUCCEEDED: "완료", FAILED: "실패", CANCELED: "취소" };
const STATUS_CLASS: Record<string, string> = {
  QUEUED: "bg-pastel-yellow text-[#6b4f00]",
  RUNNING: "bg-pastel-yellow text-[#6b4f00]",
  SUCCEEDED: "bg-pastel-mint text-[#115c43]",
  FAILED: "bg-pastel-pink text-[#8a1f4f]",
  CANCELED: "bg-gray-100 text-gray-600",
};

export default async function MyPage() {
  const owner = await readOwner();
  const persona = process.env.PERSONA_NAME ?? "까비서";
  const items = owner ? await listOwnedConversations(owner.hash) : [];
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-extrabold">내 보고서</h1>
        <p className="mt-1 text-sm text-muted">이 브라우저에서 올린 대화와 보고서예요. 다른 브라우저나 기기에서는 보이지 않으니 보고서 링크를 따로 보관해 두세요.</p>
      </header>

      {items.length === 0 ? (
        <section className="card p-8 text-center">
          <div className="text-5xl">🗂️</div>
          <p className="mt-4 font-bold">아직 올린 대화가 없어요</p>
          <p className="mt-1 text-sm text-muted">쿠키를 지웠거나 다른 브라우저라면 예전 보고서는 여기 나오지 않아요.</p>
          <Link href="/setup" className="btn-primary mt-6">
            대화 올리고 보고서 받기 →
          </Link>
        </section>
      ) : (
        <ul className="space-y-4">
          {items.map((c) => (
            <li key={c.conversationId} className="card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link href={`/c/${c.conversationId}`} className="text-lg font-extrabold hover:underline">
                  {c.title ?? "카카오톡 대화"}
                </Link>
                <span className="text-xs text-muted">올린 날 {c.createdAt.slice(0, 10)}</span>
              </div>
              <p className="mt-1 text-sm text-muted">
                {c.startedAt} ~ {c.endedAt} · 메시지 {c.messageCount.toLocaleString()}개 · 참여자 {c.participantCount}명{c.signalLabel ? ` · 📶 ${c.signalLabel}` : ""}
                {c.rawAvailable ? ` · 원문 ${c.rawExpiresAt.slice(0, 10)}까지 보관` : " · 원문 보관 기간 지남(기존 보고서만 열람)"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={`/c/${c.conversationId}/story`} className="btn-secondary text-sm">
                  📊 통계 보고서
                </Link>
                <Link href={`/c/${c.conversationId}`} className="btn-secondary text-sm">
                  대화 페이지
                </Link>
              </div>
              {c.reports.length > 0 && (
                <ul className="mt-4 space-y-2">
                  {c.reports.map((r) => (
                    <li key={r.reportId}>
                      <Link href={`/c/${c.conversationId}/reports/${r.seq}`} className="flex items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3 hover:bg-gray-50">
                        <span className="min-w-0">
                          <span className="font-bold">
                            {persona} 보고서 No.{r.seq}
                          </span>{" "}
                          <span className="block truncate text-sm text-muted sm:inline">{r.headline ?? (r.status === "RUNNING" || r.status === "QUEUED" ? `${r.progressPct}% 진행` : "")}</span>
                        </span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[r.status] ?? ""}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
