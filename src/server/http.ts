// 라우트 핸들러 공통: 에러 변환, 요청 ID, IP 해시, 소유자 식별
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { hashIp } from "./crypto";
import { notFound, toErrorResponse } from "./errors";
import { readOwner, readOrCreateOwner, setOwnerCookie, type OwnerIdentity } from "./owner";

export type RouteContext<P extends Record<string, string>> = { params: Promise<P> };

export function withApi<P extends Record<string, string>>(handler: (req: NextRequest, params: P, requestId: string) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: RouteContext<P>): Promise<NextResponse> => {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    try {
      const params = await ctx.params;
      const res = await handler(req, params, requestId);
      res.headers.set("X-Request-Id", requestId);
      return res;
    } catch (e) {
      const res = toErrorResponse(e, requestId);
      res.headers.set("X-Request-Id", requestId);
      return res;
    }
  };
}

export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd ? fwd.split(",")[0].trim() : req.headers.get("x-real-ip") ?? "0.0.0.0";
  return ip;
}

export function clientIpHash(req: NextRequest): string {
  return hashIp(clientIp(req));
}

/** 소유자 쿠키 필수. 없으면 404(존재 노출 방지) */
export async function requireOwner(): Promise<OwnerIdentity> {
  const owner = await readOwner();
  if (!owner) throw notFound();
  return owner;
}

export async function ownerForUpload(): Promise<OwnerIdentity> {
  return readOrCreateOwner();
}

export function jsonWithOwner(body: unknown, owner: OwnerIdentity, init?: { status?: number; headers?: Record<string, string> }): NextResponse {
  const res = NextResponse.json(body, init);
  if (owner.isNew) setOwnerCookie(res, owner.token);
  return res;
}
