import { NextResponse } from "next/server";
import { requireOwner, withApi } from "@/server/http";
import { deleteReport, getReportById } from "@/server/services/reports";

export const runtime = "nodejs";

export const GET = withApi<{ reportId: string }>(async (_req, { reportId }) => {
  const owner = await requireOwner();
  return NextResponse.json(await getReportById(reportId, owner.hash));
});

/** docs/18 P0-8 — 보고서 하나만 삭제. 생성 중이면 409 INVALID_STATE */
export const DELETE = withApi<{ reportId: string }>(async (_req, { reportId }) => {
  const owner = await requireOwner();
  await deleteReport(reportId, owner.hash);
  return new NextResponse(null, { status: 204 });
});
