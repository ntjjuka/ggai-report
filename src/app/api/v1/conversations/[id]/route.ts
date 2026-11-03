import { NextResponse } from "next/server";
import { requireOwner, withApi } from "@/server/http";
import { deleteConversation, getConversationDetail } from "@/server/services/conversations";

export const runtime = "nodejs";

export const GET = withApi<{ id: string }>(async (_req, { id }) => {
  const owner = await requireOwner();
  return NextResponse.json(await getConversationDetail(id, owner.hash));
});

export const DELETE = withApi<{ id: string }>(async (_req, { id }) => {
  const owner = await requireOwner();
  await deleteConversation(id, owner.hash);
  return new NextResponse(null, { status: 204 });
});
