// 소유자 토큰 (docs/10 §3): 쿠키 gg_owner 에 32바이트 토큰, DB에는 sha256 해시만
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { randomToken, sha256Hex } from "./crypto";

export const OWNER_COOKIE = "gg_owner";
const ONE_YEAR = 60 * 60 * 24 * 365;

export interface OwnerIdentity {
  token: string;
  hash: string;
  isNew: boolean;
}

export async function readOwner(): Promise<OwnerIdentity | null> {
  const jar = await cookies();
  const token = jar.get(OWNER_COOKIE)?.value;
  if (!token || token.length < 32) return null;
  return { token, hash: sha256Hex(token), isNew: false };
}

export async function readOrCreateOwner(): Promise<OwnerIdentity> {
  const existing = await readOwner();
  if (existing) return existing;
  const token = randomToken();
  return { token, hash: sha256Hex(token), isNew: true };
}

export function setOwnerCookie(res: NextResponse, token: string): void {
  res.cookies.set(OWNER_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR,
  });
}
