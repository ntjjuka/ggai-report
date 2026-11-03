import { notFound } from "next/navigation";
import ReportView from "@/components/report/ReportView";
import { DeleteReportButton, FailedScreen, ShareControls, WritingScreen } from "@/components/report/ReportStatus";
import { readOwner } from "@/server/owner";
import { getConversationDetail } from "@/server/services/conversations";
import { getReportBySeq } from "@/server/services/reports";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false } };

export default async function ReportPage({ params }: { params: Promise<{ id: string; seq: string }> }) {
  const { id, seq } = await params;
  const n = Number(seq);
  const owner = await readOwner();
  if (!owner || !Number.isInteger(n)) notFound();
  let view;
  let detail;
  try {
    view = await getReportBySeq(id, n, owner.hash);
    detail = await getConversationDetail(id, owner.hash);
  } catch {
    notFound();
  }
  const persona = process.env.PERSONA_NAME ?? "까비서";
  if (view.status === "QUEUED" || view.status === "RUNNING") {
    const eta = Math.min(10, Math.max(2, Math.ceil(detail.messageCount / 6000) * 2));
    return <WritingScreen conversationId={id} seq={n} persona={persona} initial={view} etaMinutes={eta} />;
  }
  if (view.status === "FAILED" && view.error) {
    return <FailedScreen reportId={view.reportId} persona={persona} error={view.error} />;
  }
  if (view.status === "CANCELED") {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-xl font-extrabold">취소된 보고서예요</h1>
        <a href={`/c/${id}`} className="btn-primary mt-6">
          대화로 돌아가기
        </a>
      </div>
    );
  }
  if (!view.content) notFound();
  return (
    <ReportView
      content={view.content}
      seq={n}
      isOwner
      actions={
        <div className="space-y-2">
          <ShareControls reportId={view.reportId} conversationId={id} seq={n} initialEnabled={view.share.enabled} />
          <DeleteReportButton reportId={view.reportId} conversationId={id} />
        </div>
      }
    />
  );
}
