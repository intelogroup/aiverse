import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { ownerReadKeys } from "@aiverse/shared/schema";
import { generateOwnerReadKey } from "../middleware/ownerReadAuth";
import { withCapLock } from "../db/capLock";
import { ownerAuth } from "../middleware/ownerAuth";
import { audit } from "../util/audit";

export const ownersReadKeysRoute = new Hono<{ Variables: { ownerId: string } }>();

// Read keys: long-lived, read-only credentials for observer clients (the
// Verse MCP server). Managed only from a full console session — a read key
// can never mint, list or revoke keys. The plaintext is returned once.
const MAX_ACTIVE_READ_KEYS = 10;

ownersReadKeysRoute.post("/read-keys", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const body = await c.req.json<{ label?: string }>().catch(() => ({}) as { label?: string });
  // typeof first: ?? "" only coalesces null/undefined, so a truthy
  // non-string label throws TypeError on .trim() → 500
  // (AIV-OWNER-TEXT-TYPE-001).
  if (body.label != null && typeof body.label !== "string") return c.json({ error: "label required (1-60 chars)" }, 400);
  const label = (body.label ?? "").trim();
  if (label.length < 1 || label.length > 60) return c.json({ error: "label required (1-60 chars)" }, 400);

  const { key, hash } = generateOwnerReadKey();
  // Count + insert under the per-owner cap lock (db/capLock.ts): the old
  // list-then-insert let a concurrent burst mint keys past the cap
  // (AIV-READKEYS-CAP-RACE-001).
  const row = await withCapLock(`cap:read-keys:${ownerId}`, async (tx) => {
    const active = await tx.query.ownerReadKeys.findMany({
      where: and(eq(ownerReadKeys.ownerId, ownerId), isNull(ownerReadKeys.revokedAt)),
      columns: { id: true },
    });
    if (active.length >= MAX_ACTIVE_READ_KEYS) return null;
    const [created] = await tx.insert(ownerReadKeys).values({ ownerId, keyHash: hash, label }).returning();
    return created;
  });
  if (!row) {
    return c.json({ error: `too many active read keys (max ${MAX_ACTIVE_READ_KEYS}) — revoke one first` }, 409);
  }
  await audit({ event: "owner.read_key_created", ownerId, actorType: "owner", actorId: ownerId, metadata: { keyId: row.id, label } });
  return c.json({ readKey: { id: row.id, label: row.label, createdAt: row.createdAt }, key }, 201);
});

ownersReadKeysRoute.get("/read-keys", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const keys = await db.query.ownerReadKeys.findMany({
    where: eq(ownerReadKeys.ownerId, ownerId),
    columns: { id: true, label: true, createdAt: true, lastUsedAt: true, revokedAt: true },
    orderBy: desc(ownerReadKeys.createdAt),
  });
  return c.json({ readKeys: keys });
});

ownersReadKeysRoute.delete("/read-keys/:id", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const [revoked] = await db
    .update(ownerReadKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(ownerReadKeys.id, c.req.param("id")), eq(ownerReadKeys.ownerId, ownerId), isNull(ownerReadKeys.revokedAt)))
    .returning({ id: ownerReadKeys.id });
  if (!revoked) return c.json({ error: "not found" }, 404);
  await audit({ event: "owner.read_key_revoked", ownerId, actorType: "owner", actorId: ownerId, metadata: { keyId: revoked.id } });
  return c.json({ ok: true });
});
