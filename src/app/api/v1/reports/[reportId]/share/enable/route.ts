import { NextResponse } from "next/server";
import { requireOwner, withApi } from "@/server/http";
import { enableShare } from "@/server/services/reports";

export const runtime = "nodejs";

export const POST = withApi<{ reportId: string }>(async (_req, { reportId }) => {
  const owner = await requireOwner();
  const { url } = await enableShare(reportId, owner.hash);
  return NextResponse.json({ url });
});
