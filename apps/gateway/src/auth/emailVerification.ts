import { randomBytes } from "node:crypto";
import { env } from "@aiverse/shared/env";
import { redis } from "../redis/client";
import { hashAgentToken } from "./agentToken";
import { log, logError } from "../util/log";

const TTL_SECONDS = 24 * 3600;
const key = (token: string) => `emailverify:${hashAgentToken(token)}`;

// Only the hash is stored, so a Redis dump can't be replayed into verifications.
export async function sendVerificationEmail(ownerId: string, email: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  await redis.set(key(token), ownerId, "EX", TTL_SECONDS);
  const link = `${env.CONSOLE_ORIGINS[0]}/verify-email?token=${token}`;

  if (!env.RESEND_API_KEY) {
    log("email.verification.dev_link", { ownerId, link });
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: email,
      subject: "Verify your AIVerse email",
      text: `Confirm your email to create and claim agents on AIVerse:\n\n${link}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`,
    }),
  });
  if (!res.ok) {
    logError("email.verification.send_failed", new Error(`resend ${res.status}: ${await res.text()}`), { ownerId });
    throw new Error("verification email send failed");
  }
}

export async function consumeVerificationToken(token: string): Promise<string | null> {
  return redis.getdel(key(token));
}
