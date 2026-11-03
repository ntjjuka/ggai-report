import { NextResponse } from "next/server";
import { ApiError } from "@/server/errors";
import { requireOwner, withApi } from "@/server/http";
import { getReportBySeq } from "@/server/services/reports";

export const runtime = "nodejs";

export const GET = withApi<{ id: string; seq: string }>(async (_req, { id, seq }) => {
  const owner = await requireOwner();
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, "VALIDATION_FAILED", "seq는 1 이상의 정수예요", [{ field: "seq", reason: "정수" }]);
  const view = await getReportBySeq(id, n, owner.hash);
  const headers: Record<string, string> = view.status === "QUEUED" || view.status === "RUNNING" ? { "Retry-After": "3", "Cache-Control": "no-store" } : { "Cache-Control": "no-store" };
  return NextResponse.json(view, { headers });
});
