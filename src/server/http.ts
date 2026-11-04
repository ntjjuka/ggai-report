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

/**
 * 공유 링크 등 사용자가 복사해 가는 절대 주소의 기준. APP_BASE_URL이 localhost면(기본값) 휴대폰·다른 기기에서 열 수 없으므로
 * 요청이 실제로 들어온 호스트(x-forwarded-host/host)를 쓴다. 역방향 프록시 뒤에서는 x-forwarded-proto/host를 따른다.
 */
export function publicBaseUrl(req: { headers: { get(name: string): string | null } }, configured: string): string {
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host")?.trim();
  if (!host) return configured.replace(/\/$/, "");
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || (configured.startsWith("https://") ? "https" : "http");
  return `${proto}://${host}`;
}

/** 서버 컴포넌트용: `next/headers`의 `headers()` 결과로 같은 기준 주소를 만든다 */
export function publicBaseFromHeaders(h: { get(name: string): string | null }, configured: string): string {
  return publicBaseUrl({ headers: h }, configured);
}

/** 저장된 절대 URL의 origin을 기준 주소로 바꾼다 (경로·쿼리는 유지) */
export function rebaseUrl(url: string, base: string): string {
  try {
    const u = new URL(url);
    return `${base.replace(/\/$/, "")}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
