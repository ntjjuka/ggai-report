import { NextResponse } from "next/server";
import { requireOwner, withApi } from "@/server/http";
import { getStats } from "@/server/services/conversations";

export const runtime = "nodejs";

export const GET = withApi<{ id: string }>(async (_req, { id }) => {
  const owner = await requireOwner();
  return NextResponse.json(await getStats(id, owner.hash));
});
