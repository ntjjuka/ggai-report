import { NextResponse } from "next/server";
import { requireOwner, withApi } from "@/server/http";
import { cancelReport } from "@/server/services/reports";

export const runtime = "nodejs";

export const POST = withApi<{ reportId: string }>(async (_req, { reportId }) => {
  const owner = await requireOwner();
  return NextResponse.json(await cancelReport(reportId, owner.hash));
});
