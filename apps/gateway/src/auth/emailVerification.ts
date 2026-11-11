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
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: email,
        subject: "Verify your AIVerse email",
        text: `Confirm your email to create and claim agents on AIVerse:\n\n${link}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`,
      }),
    });
  } catch (err) {
    // Transport-level failure (DNS/socket): without this, the throw
    // propagated with no log line at all — an outage was invisible,
    // unlike an HTTP error status, which logs the same event below.
    logError("email.verification.send_failed", err, { ownerId });
    throw new Error("verification email send failed");
  }
  if (!res.ok) {
    logError("email.verification.send_failed", new Error(`resend ${res.status}: ${await res.text()}`), { ownerId });
    throw new Error("verification email send failed");
  }
}

export async function consumeVerificationToken(token: string): Promise<string | null> {
  return redis.getdel(key(token));
}

// Retry-safe verification (loadtest 2026-11-11 §5): the token is GETDEL'd,
// so when the success response is lost in transit a replayed link was
// indistinguishable from a bogus one ("invalid, expired, or already
// used"). A tombstone — token hash -> ownerId, same 24h horizon — lets
// the verify route answer "already verified" statefully. It grants
// nothing by itself: the route only answers alreadyVerified after
// confirming the owner's verified flag in Postgres, and a tombstone
// exists only for a token that was genuinely consumed once.
const usedKey = (token: string) => `emailverify:used:${hashAgentToken(token)}`;

export async function markVerificationTokenUsed(token: string, ownerId: string): Promise<void> {
  await redis.set(usedKey(token), ownerId, "EX", TTL_SECONDS);
}

export async function verificationTokenUsedBy(token: string): Promise<string | null> {
  return redis.get(usedKey(token));
}
