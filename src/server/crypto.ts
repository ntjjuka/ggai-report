import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getConfig } from "./config";

const NONCE_LEN = 12;
const TAG_LEN = 16;

/** AES-256-GCM. 출력: nonce(12) || ciphertext || tag(16). AAD = conversationId */
export function encryptRaw(plain: Uint8Array, aad: string): Buffer {
  const key = getConfig().cryptoKey;
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

export function decryptRaw(blob: Uint8Array, aad: string): Buffer {
  const key = getConfig().cryptoKey;
  const buf = Buffer.from(blob);
  const nonce = buf.subarray(0, NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(NONCE_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 32바이트 URL-safe 토큰 */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashIp(ip: string): string {
  return sha256Hex(`${getConfig().IP_HASH_SALT}|${ip}`);
}
