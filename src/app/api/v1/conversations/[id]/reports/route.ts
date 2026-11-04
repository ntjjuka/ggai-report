import { NextResponse } from "next/server";
import { z } from "zod";
import { FOCUS } from "@/lib/report/schema";
import { requireOwner, withApi } from "@/server/http";
import { createReport } from "@/server/services/reports";

export const runtime = "nodejs";

const Body = z.object({
  focus: z.enum(FOCUS).default("AUTO"),
  focusQuestion: z.string().max(300).nullable().optional(),
});

/** POST /api/v1/conversations/{id}/reports → 202 QUEUED */
export const POST = withApi<{ id: string }>(async (req, { id }) => {
  const owner = await requireOwner();
  const raw = await req.text();
  const body = Body.parse(raw ? JSON.parse(raw) : {});
  const view = await createReport(id, owner.hash, { focus: body.focus, focusQuestion: body.focusQuestion ?? null });
  return NextResponse.json({ ...view, statusUrl: `/api/v1/conversations/${id}/reports/${view.seq}` }, { status: 202 });
});
