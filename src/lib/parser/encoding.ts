import iconv from "iconv-lite";
import { ParseError } from "./types";

export interface DecodedText {
  text: string;
  charset: "UTF-8" | "UTF-16LE" | "UTF-16BE" | "CP949";
  fallbackUsed: boolean;
}

/** docs/03 §1.2: BOM → UTF-8 strict → CP949 strict → ENCODING_UNDETECTED */
export function decodeBytes(bytes: Uint8Array): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), charset: "UTF-8", fallbackUsed: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), charset: "UTF-16LE", fallbackUsed: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), charset: "UTF-16BE", fallbackUsed: false };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), charset: "UTF-8", fallbackUsed: false };
  } catch {
    // fall through
  }
  const cp949 = iconv.decode(Buffer.from(bytes), "cp949");
  // iconv-lite는 예외 대신 U+FFFD로 치환한다 → 치환 문자가 있으면 판별 실패로 본다
  if (cp949.includes("�")) {
    throw new ParseError("ENCODING_UNDETECTED");
  }
  return { text: cp949, charset: "CP949", fallbackUsed: true };
}
