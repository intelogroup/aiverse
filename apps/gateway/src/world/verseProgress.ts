import { and, eq, gt, sql } from "drizzle-orm";
import { EGGS } from "@aiverse/shared/eggs";
import { verseInventory, versePickupClaims, verseProgressEvents } from "@aiverse/shared/schema";
import { db } from "../db/client";

export const PILOT_PICKUP = {
  id: "garden-keepsake",
  target: "egg-bazaar-02",
  name: "Tea House garden keepsake",
  credits: 3,
  xp: 5,
} as const;

export const pickupPosition = EGGS[PILOT_PICKUP.target].position;

export async function progress(agentId: string) {
  const [totals] = await db.select({
    credits: sql<number>`coalesce(sum(${verseProgressEvents.credits}), 0)::float8`,
    xp: sql<number>`coalesce(sum(${verseProgressEvents.xp}), 0)::float8`,
  }).from(verseProgressEvents).where(eq(verseProgressEvents.agentId, agentId));
  return totals;
}

type LedgerWriter = Pick<typeof db, "insert">;
export async function awardXp(tx: LedgerWriter, agentId: string, kind: string, source: string, xp: number) {
  await tx.insert(verseProgressEvents).values({ agentId, kind, source, xp }).onConflictDoNothing();
}

export async function awardConversationXp(agentId: string, source: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`verse-conversation:${agentId}`}, 0))`);
    const [recent] = await tx.select({ source: verseProgressEvents.source }).from(verseProgressEvents)
      .where(and(eq(verseProgressEvents.agentId, agentId), eq(verseProgressEvents.kind, "conversation"),
        gt(verseProgressEvents.createdAt, sql`clock_timestamp() - interval '2 minutes'`))).limit(1);
    if (!recent) await awardXp(tx, agentId, "conversation", source, 1);
  });
}

export async function pickupReceipt(agentId: string) {
  const [claim] = await db.select().from(versePickupClaims).where(eq(versePickupClaims.pickupId, PILOT_PICKUP.id));
  if (!claim) return null;
  return claim.agentId === agentId ? { itemId: claim.itemId, credits: PILOT_PICKUP.credits, xp: PILOT_PICKUP.xp } : false;
}

export async function awardPickup(agentId: string) {
  return db.transaction(async (tx) => {
    const [entry] = await tx.insert(versePickupClaims).values({ pickupId: PILOT_PICKUP.id, agentId })
      .onConflictDoNothing().returning();
    if (!entry) {
      const [existing] = await tx.select().from(versePickupClaims).where(eq(versePickupClaims.pickupId, PILOT_PICKUP.id));
      return existing?.agentId === agentId
        ? { itemId: existing.itemId, credits: PILOT_PICKUP.credits, xp: PILOT_PICKUP.xp }
        : false;
    }
    const [item] = await tx.insert(verseInventory).values({ agentId, name: PILOT_PICKUP.name }).returning();
    await tx.update(versePickupClaims).set({ itemId: item.id }).where(eq(versePickupClaims.pickupId, entry.pickupId));
    await tx.insert(verseProgressEvents).values({
      agentId, kind: "pickup", source: entry.pickupId, credits: PILOT_PICKUP.credits, xp: PILOT_PICKUP.xp,
    });
    return { itemId: item.id, credits: PILOT_PICKUP.credits, xp: PILOT_PICKUP.xp };
  });
}
