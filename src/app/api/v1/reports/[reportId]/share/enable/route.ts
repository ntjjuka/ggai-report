import { NextResponse } from "next/server";
import { getConfig } from "@/server/config";
import { publicBaseUrl, rebaseUrl, requireOwner, withApi } from "@/server/http";
import { enableShare } from "@/server/services/reports";

export const runtime = "nodejs";

export const POST = withApi<{ reportId: string }>(async (req, { reportId }) => {
  const owner = await requireOwner();
  const { url, token } = await enableShare(reportId, owner.hash);
  // 복사해 가는 링크는 이 요청이 들어온 주소 기준 (APP_BASE_URL=localhost여도 휴대폰에서 열리게)
  return NextResponse.json({ url: rebaseUrl(url, publicBaseUrl(req, getConfig().APP_BASE_URL)), token });
});
