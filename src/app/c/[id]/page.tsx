import Link from "next/link";
import { notFound } from "next/navigation";
import { DeleteConversationButton, NewReportForm } from "@/components/report/ReportStatus";
import { readOwner } from "@/server/owner";
import { getConversationDetail } from "@/server/services/conversations";

export const dynamic = "force-dynamic";
export const metadata = { title: "내 대화", robots: { index: false } };

const STATUS_LABEL: Record<string, string> = { QUEUED: "대기 중", RUNNING: "작성 중", SUCCEEDED: "완료", FAILED: "실패", CANCELED: "취소" };

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owner = await readOwner();
  if (!owner) notFound();
  let d;
  try {
    d = await getConversationDetail(id, owner.hash);
  } catch {
    notFound();
  }
  const persona = process.env.PERSONA_NAME ?? "까비서";
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-extrabold">{d.title ?? "카카오톡 대화"}</h1>
        <p className="mt-1 text-sm text-muted">
          {d.startedAt.slice(0, 10)} ~ {d.endedAt.slice(0, 10)} · 메시지 {d.messageCount.toLocaleString()}개 · 참여자 {d.effectiveParticipantCount}명{d.tier0 ? ` · 📶 ${d.tier0.signalLabel}` : ""}
        </p>
        <p className="mt-1 text-xs text-muted">{d.rawAvailable ? `원문은 ${d.rawExpiresAt.slice(0, 10)}에 자동 삭제돼요.` : "원문 보관 기간이 지나 새 보고서는 만들 수 없어요. 기존 보고서는 계속 볼 수 있어요."}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={`/c/${id}/story`} className="btn-secondary text-sm">
            📊 통계 보고서 (즉시)
          </Link>
          {d.rawAvailable && (
            <Link href={`/setup?c=${id}&back=${encodeURIComponent(`/c/${id}`)}`} className="btn-secondary text-sm">
              참여자·이름 다시 정리
            </Link>
          )}
        </div>
      </header>

      <section>
        <h2 className="mb-3 text-lg font-extrabold">{persona} 보고서</h2>
        {d.reports.length === 0 ? (
          <p className="text-sm text-muted">아직 보고서가 없어요.</p>
        ) : (
          <ul className="space-y-2">
            {d.reports.map((r) => (
              <li key={r.reportId}>
                <Link href={`/c/${id}/reports/${r.seq}`} className="card flex items-center justify-between px-4 py-3">
                  <span>
                    <span className="font-bold">No.{r.seq}</span> <span className="text-sm text-muted">{r.headline ?? STATUS_LABEL[r.status] ?? r.status}</span>
                  </span>
                  <span className="text-xs text-muted">{r.createdAt.slice(0, 10)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {d.rawAvailable && <NewReportForm conversationId={id} defaultFocus={d.defaultFocus} persona={persona} />}

      <section className="border-t border-line pt-6">
        <DeleteConversationButton conversationId={id} />
      </section>
    </div>
  );
}
