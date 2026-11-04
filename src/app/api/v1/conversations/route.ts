import { z } from "zod";
import { FOCUS } from "@/lib/report/schema";
import { clientIpHash, jsonWithOwner, ownerForUpload, withApi } from "@/server/http";
import { ApiError } from "@/server/errors";
import { listOwnedConversations, uploadConversation } from "@/server/services/conversations";
import { readOwner } from "@/server/owner";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const FocusSchema = z.enum(FOCUS);

/** GET /api/v1/conversations — 이 브라우저(소유자 쿠키)의 대화·보고서 목록. 쿠키가 없으면 빈 목록 */
export const GET = withApi(async () => {
  const owner = await readOwner();
  return NextResponse.json({ conversations: owner ? await listOwnedConversations(owner.hash) : [] });
});

/** POST /api/v1/conversations — multipart(files[], title?, focus?) → 201 대화 상세 (재업로드면 200 reused) */
export const POST = withApi(async (req) => {
  const owner = await ownerForUpload();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError(400, "VALIDATION_FAILED", "multipart/form-data 로 보내 주세요", [{ field: "files", reason: "multipart 필요" }]);
  }
  const files = form.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
  if (files.length === 0) throw new ApiError(400, "VALIDATION_FAILED", "파일을 올려 주세요", [{ field: "files", reason: "필수" }]);
  const title = form.get("title");
  const focusRaw = form.get("focus");
  const focus = typeof focusRaw === "string" && FocusSchema.safeParse(focusRaw).success ? focusRaw : null;
  const inputs = await Promise.all(files.map(async (f) => ({ name: f.name || "upload.txt", bytes: new Uint8Array(await f.arrayBuffer()) })));
  const { detail, reused } = await uploadConversation({ files: inputs, ownerHash: owner.hash, ipHash: clientIpHash(req), title: typeof title === "string" ? title : null, focus });
  return jsonWithOwner({ ...detail, reused }, owner, { status: reused ? 200 : 201 });
});
