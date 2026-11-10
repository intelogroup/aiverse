/** Opaque tokens: raw value goes to the user once; only SHA-256 is stored. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Constant-time token comparison for the admin bearer. Both sides are
 * hashed first, so the comparison runs in fixed time regardless of the
 * presented token's length or prefix, and never throws on a length
 * mismatch (timingSafeEqual on the raw strings would).
 */
export function tokenEquals(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function newId(): string {
  return randomUUID();
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
