import { unzipSync } from "fflate";
import { ParseError, type NamedBytes } from "./types";

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxTotalBytes: 200 * 1024 * 1024,
  maxCompressionRatio: 100,
};

const TEXT_EXT = /\.(txt|csv)$/i;

/** docs/03 §1·§1.1: zip 안에서 .txt/.csv만 추출. 경로 탈출·엔트리 수·총량·압축률 검사. 중첩 zip은 무시. */
export function extractTextEntries(zipBytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): NamedBytes[] {
  let count = 0;
  let total = 0;
  const out: NamedBytes[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zipBytes, {
      filter: (file) => {
        count += 1;
        if (count > limits.maxEntries) throw new ParseError("ZIP_TOO_MANY_ENTRIES");
        const name = file.name;
        if (name.includes("..") || name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) {
          throw new ParseError("ZIP_UNSAFE_ENTRY", name);
        }
        if (name.endsWith("/")) return false; // 디렉터리
        if (!TEXT_EXT.test(name)) return false; // 미디어 등 무시
        if (file.originalSize > 0 && file.size > 0 && file.originalSize / file.size > limits.maxCompressionRatio) {
          throw new ParseError("ZIP_BOMB_SUSPECTED", name);
        }
        total += file.originalSize;
        if (total > limits.maxTotalBytes) throw new ParseError("ZIP_TOO_LARGE");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ParseError) throw e;
    throw new ParseError("ZIP_INVALID", e instanceof Error ? e.message : String(e));
  }
  for (const [name, bytes] of Object.entries(files)) {
    // __MACOSX/._x 같은 리소스 포크 제외
    const base = name.split("/").pop() ?? name;
    if (name.startsWith("__MACOSX/") || base.startsWith("._")) continue;
    out.push({ name: base, bytes });
  }
  return out;
}
