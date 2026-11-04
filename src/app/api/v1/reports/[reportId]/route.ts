import { NextResponse } from "next/server";
import { getConfig } from "@/server/config";
import { publicBaseUrl, rebaseUrl, requireOwner, withApi } from "@/server/http";
import { deleteReport, getReportById } from "@/server/services/reports";

export const runtime = "nodejs";

export const GET = withApi<{ reportId: string }>(async (req, { reportId }) => {
  const owner = await requireOwner();
  const view = await getReportById(reportId, owner.hash);
  // 공유 링크는 이 요청이 들어온 주소 기준(share/enable 응답과 같은 규칙)
  const url = view.share.url ? rebaseUrl(view.share.url, publicBaseUrl(req, getConfig().APP_BASE_URL)) : null;
  return NextResponse.json({ ...view, share: { ...view.share, url } });
});

/** docs/18 P0-8 — 보고서 하나만 삭제. 생성 중이면 409 INVALID_STATE */
export const DELETE = withApi<{ reportId: string }>(async (_req, { reportId }) => {
  const owner = await requireOwner();
  await deleteReport(reportId, owner.hash);
  return new NextResponse(null, { status: 204 });
});
