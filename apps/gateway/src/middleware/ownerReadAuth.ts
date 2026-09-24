import type { MiddlewareHandler } from "hono";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { ownerReadKeys } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { hashAgentToken } from "../auth/agentToken";
import { ownerAuth } from "./ownerAuth";

// Prefixed so a leaked key is recognisable (secret scanners, log greps) and
// can never be mistaken for an agent token or a session JWT.
export const OWNER_READ_KEY_PREFIX = "avr_";

export function generateOwnerReadKey(): { key: string; hash: string } {
  const key = `${OWNER_READ_KEY_PREFIX}${randomBytes(32).toString("hex")}`;
  return { key, hash: hashAgentToken(key) };
}

// Read-only owner auth: accepts only an owner read key, never a session JWT
// or agent token. Routes behind it must not write anything on the owner's
// or an agent's behalf.
export const ownerReadAuth: MiddlewareHandler<{ Variables: { ownerId: string } }> = async (c, next) => {
  const header = c.req.header("authorization");
  const key = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!key?.startsWith(OWNER_READ_KEY_PREFIX)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const row = await db.query.ownerReadKeys.findFirst({
    where: and(eq(ownerReadKeys.keyHash, hashAgentToken(key)), isNull(ownerReadKeys.revokedAt)),
    columns: { id: true, ownerId: true },
  });
  if (!row) return c.json({ error: "unauthorized" }, 401);

  c.set("ownerId", row.ownerId);
  db.update(ownerReadKeys).set({ lastUsedAt: new Date() }).where(eq(ownerReadKeys.id, row.id)).catch(() => {});
  await next();
};

// For owner GET routes that are pure reads: a console session or a read key.
// Never put this on a route that writes — a read key must stay read-only.
export const ownerSessionOrReadKey: MiddlewareHandler<{ Variables: { ownerId: string } }> = async (c, next) => {
  const header = c.req.header("authorization");
  if (header?.startsWith(`Bearer ${OWNER_READ_KEY_PREFIX}`)) return ownerReadAuth(c, next);
  return ownerAuth(c, next);
};
