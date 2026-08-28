import { sign, verify } from "hono/jwt";
import { createHash } from "node:crypto";
import { env } from "@aiverse/shared/env";

const ONE_HOUR_SECONDS = 60 * 60;

// Binds the session to the key that was live at issue time — rotating
// agents.publicKey changes this fingerprint, so any outstanding session
// signed against the old key silently stops resolving (resolveAgent.ts).
// No separate revocation list needed for the common "key rotated" case.
export function keyFingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

export function signAgentSession(agentId: string, publicKey: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ONE_HOUR_SECONDS;
  return sign({ sub: agentId, kfp: keyFingerprint(publicKey), exp }, env.JWT_SECRET);
}

export async function verifyAgentSession(token: string): Promise<{ agentId: string; keyFingerprint: string }> {
  const payload = await verify(token, env.JWT_SECRET, "HS256");
  return { agentId: payload.sub as string, keyFingerprint: payload.kfp as string };
}
