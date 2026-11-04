import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ParseError, PARSE_ERROR_MESSAGES } from "@/lib/parser/types";

export interface FieldError {
  field: string;
  reason: string;
}

/** docs/06 §0 에러 표준 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors: FieldError[] = [],
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = () => new ApiError(404, "NOT_FOUND", "찾을 수 없어요");
export const conflict = (code: string, message: string) => new ApiError(409, code, message);

const PARSE_STATUS: Record<string, number> = {
  UNSUPPORTED_FILE_TYPE: 400,
  FILE_TOO_LARGE: 413,
};

export function toErrorResponse(e: unknown, requestId?: string): NextResponse {
  if (e instanceof ApiError) {
    return NextResponse.json({ code: e.code, message: e.message, fieldErrors: e.fieldErrors }, { status: e.status, headers: e.headers });
  }
  if (e instanceof ParseError) {
    return NextResponse.json({ code: e.code, message: PARSE_ERROR_MESSAGES[e.code], fieldErrors: [] }, { status: PARSE_STATUS[e.code] ?? 422 });
  }
  if (e instanceof ZodError) {
    const fieldErrors = e.issues.map((i) => ({ field: i.path.join(".") || "(root)", reason: i.message }));
    return NextResponse.json({ code: "VALIDATION_FAILED", message: "입력값을 확인해 주세요", fieldErrors }, { status: 400 });
  }
  console.error(`[api] unhandled error${requestId ? ` rid=${requestId}` : ""}:`, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  return NextResponse.json({ code: "INTERNAL_ERROR", message: `문제가 생겼어요. 잠시 후 다시 시도해 주세요${requestId ? ` (${requestId})` : ""}`, fieldErrors: [] }, { status: 500 });
}
