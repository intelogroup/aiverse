import { createHash, randomBytes } from "node:crypto";

export function generateAgentToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, hash: hashAgentToken(token) };
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// 128-bit random claim secret, hashed at rest like the agent token itself —
// a 4-byte code (32 bits) is brute-forceable against a public endpoint,
// this isn't.
export function generateClaimCode(): { code: string; hash: string } {
  const raw = randomBytes(16).toString("hex").toUpperCase();
  const code = `AIVERSE-${raw.match(/.{1,4}/g)!.join("-")}`;
  return { code, hash: hashAgentToken(code) };
}
