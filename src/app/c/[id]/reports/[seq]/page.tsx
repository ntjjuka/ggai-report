import { headers } from "next/headers";
import { notFound } from "next/navigation";
import ReportView from "@/components/report/ReportView";
import { DeleteReportButton, FailedScreen, ShareControls, WritingScreen } from "@/components/report/ReportStatus";
import { getConfig } from "@/server/config";
import { publicBaseFromHeaders, rebaseUrl } from "@/server/http";
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
    // 압축 전사 + 청크 병렬 8 + 종합 medium 기준: 1만 개 ≈ 2분, 5만 개 ≈ 4분, 그 이상 ≈ 5~6분
    const eta = Math.min(6, Math.max(2, Math.ceil(detail.messageCount / 15000) + 1));
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
  // 켜 둔 공유 링크는 새로 고침·재배포 뒤에도 그대로 보여 준다(토큰 원문은 암호화 보관). 주소는 지금 접속한 호스트 기준
  const shareUrl = view.share.url ? rebaseUrl(view.share.url, publicBaseFromHeaders(await headers(), getConfig().APP_BASE_URL)) : null;
  return (
    <ReportView
      content={view.content}
      seq={n}
      isOwner
      actions={
        <div className="space-y-2">
          <ShareControls reportId={view.reportId} conversationId={id} seq={n} initialEnabled={view.share.enabled} initialUrl={shareUrl} />
          <DeleteReportButton reportId={view.reportId} conversationId={id} />
        </div>
      }
    />
  );
}
