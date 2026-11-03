import { NextResponse } from "next/server";
import { withApi } from "@/server/http";
import { getSharedReport } from "@/server/services/reports";

export const runtime = "nodejs";

export const GET = withApi<{ token: string }>(async (_req, { token }) => {
  const shared = await getSharedReport(token);
  return NextResponse.json(shared, { headers: { "X-Robots-Tag": "noindex, nofollow, noarchive", "Cache-Control": "private, no-store" } });
});
