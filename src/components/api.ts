"use client";
// 클라이언트용 API 호출 헬퍼: 에러 표준({code,message,fieldErrors})을 예외로 변환
export class ClientApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors: { field: string; reason: string }[] = [],
  ) {
    super(message);
  }
}

export async function api<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { ...init, headers: { ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { code?: string; message?: string; fieldErrors?: { field: string; reason: string }[] };
    throw new ClientApiError(res.status, b.code ?? "HTTP_ERROR", b.message ?? `요청 실패 (${res.status})`, b.fieldErrors ?? []);
  }
  return body as T;
}
