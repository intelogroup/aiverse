import { sign, verify } from "hono/jwt";
import { and, eq, isNull, sql } from "drizzle-orm";
import { owners, ownerReadKeys } from "@aiverse/shared/schema";
import { env } from "@aiverse/shared/env";
import { db } from "../db/client";

const ONE_WEEK_SECONDS = 60 * 60 * 24 * 7;

// `sv` pins the token to owners.session_version at issue time. A signature
// check alone can't revoke anything, so verify also reads the row: a deleted
// owner or a bumped version (logout-all, password change/reset) kills every
// outstanding token immediately rather than at `exp`. Tokens minted before
// `sv` existed carry none and are rejected.
export function signOwnerSession(ownerId: string, sessionVersion: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ONE_WEEK_SECONDS;
  return sign({ sub: ownerId, sv: sessionVersion, exp }, env.JWT_SECRET);
}

export async function verifyOwnerSession(token: string): Promise<string> {
  const payload = await verify(token, env.JWT_SECRET, "HS256");
  const ownerId = payload.sub as string;
  if (typeof payload.sv !== "number") throw new Error("session predates revocation support");
  const owner = await db.query.owners.findFirst({
    where: eq(owners.id, ownerId),
    columns: { sessionVersion: true },
  });
  if (!owner || owner.sessionVersion !== payload.sv) throw new Error("session revoked");
  return ownerId;
}

// Invalidates every session for this owner and returns the new version, so
// the caller can mint a fresh token for the device that asked.
// Read keys go too: "log me out everywhere" after a suspected compromise has
// to cover the long-lived keys pasted into MCP clients, not just sessions.
export async function revokeOwnerSessions(ownerId: string): Promise<number> {
  const [row] = await db
    .update(owners)
    .set({ sessionVersion: sql`${owners.sessionVersion} + 1` })
    .where(eq(owners.id, ownerId))
    .returning({ sessionVersion: owners.sessionVersion });
  await db
    .update(ownerReadKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(ownerReadKeys.ownerId, ownerId), isNull(ownerReadKeys.revokedAt)));
  return row.sessionVersion;
}
