import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner, withApi } from "@/server/http";
import { confirmParticipants } from "@/server/services/conversations";

export const runtime = "nodejs";

const Body = z.object({
  uploaderParticipantId: z.string().uuid().nullable().optional(),
  merges: z.array(z.object({ from: z.string().uuid(), into: z.string().uuid() })).max(100).default([]),
  excluded: z.array(z.string().uuid()).max(200).default([]),
  displayNames: z.record(z.string(), z.string().max(100)).default({}),
  title: z.string().max(200).optional(),
});

export const POST = withApi<{ id: string }>(async (req, { id }) => {
  const owner = await requireOwner();
  const body = Body.parse(await req.json());
  const detail = await confirmParticipants(id, owner.hash, {
    uploaderParticipantId: body.uploaderParticipantId ?? null,
    merges: body.merges,
    excluded: body.excluded,
    displayNames: body.displayNames,
    title: body.title,
  });
  return NextResponse.json(detail);
});
