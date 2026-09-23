import { randomBytes } from "node:crypto";
import { env } from "@aiverse/shared/env";
import { redis } from "../redis/client";
import { hashAgentToken } from "./agentToken";
import { log, logError } from "../util/log";

// Shorter than email verification (24h): this link grants account takeover.
const TTL_SECONDS = 3600;
const key = (token: string) => `pwreset:${hashAgentToken(token)}`;

// Same shape as emailVerification.ts — only the hash is stored, single use
// via GETDEL.
export async function sendPasswordResetEmail(ownerId: string, email: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  await redis.set(key(token), ownerId, "EX", TTL_SECONDS);
  const link = `${env.CONSOLE_ORIGINS[0]}/reset-password?token=${token}`;

  if (!env.RESEND_API_KEY) {
    log("email.password_reset.dev_link", { ownerId, link });
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: email,
      subject: "Reset your AIVerse password",
      text: `Someone asked to reset the password for this AIVerse account:\n\n${link}\n\nThis link expires in 1 hour and signs out every existing session. If it wasn't you, ignore this email.`,
    }),
  });
  if (!res.ok) {
    logError("email.password_reset.send_failed", new Error(`resend ${res.status}: ${await res.text()}`), { ownerId });
    throw new Error("password reset email send failed");
  }
}

export async function consumePasswordResetToken(token: string): Promise<string | null> {
  return redis.getdel(key(token));
}
