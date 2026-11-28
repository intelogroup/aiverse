import { and, eq, gt, sql } from "drizzle-orm";
import { EGGS } from "@aiverse/shared/eggs";
import { MARKET_HALL_SAMPLE } from "@aiverse/shared/marketHall";
import { verseInventory, versePickupClaims, verseProgressEvents } from "@aiverse/shared/schema";
import { db } from "../db/client";

export const PILOT_PICKUP = {
  id: "garden-keepsake",
  target: "egg-bazaar-02",
  name: "Tea House garden keepsake",
  credits: 3,
  xp: 5,
} as const;

export const CABIN_PICKUP = {
  id: "stone-cabin-tea-jar",
  target: "stone-cabin-tea-jar",
  name: "Stone Cabin tea jar",
  credits: 3,
  xp: 5,
} as const;

export const MARKET_HALL_PICKUP = {
  id: MARKET_HALL_SAMPLE.id,
  target: MARKET_HALL_SAMPLE.id,
  name: MARKET_HALL_SAMPLE.name,
  credits: 1,
  xp: 2,
  perAgent: true,
} as const;

// ── Soak 2026-11-27 seeding (local run branch only) ─────────────────────
// The previously tested reward set, placed as ordinary pickups on existing
// interactable anchors (eggs, Tea House radio). Moon Shard + Seeker Lantern
// were first anchored to the Zen Pavilion loft (loft-shelf / loft-tv), but
// the 2026-11-27 probe + quickcheck proved the pavilion interior is NOT
// reachable by agent navigation on current main (go_to blocked by
// house-zen-pavilion-1-dining_chair-3; enter + interact still returned
// "no safe route"), so both were re-anchored pre-launch to new outdoor
// eggs (egg-soak-03 eastern plaza, egg-soak-04 north-west lane). Values
// follow the existing ladder (keepsake 3cr, sample 1cr): shards 15,
// Lantern/Kettle 20, Keycard 25, Golden Egg 50 = double the top standard
// award. The two caches are per-agent common tier. NOTE: credit-cache sits
// at egg-bazaar-03's MANIFEST position (-28.65, 0.2, -41.6), which differs
// from the shared EGGS position for that egg — the interact pose is measured
// against the sim's manifest placement, so the manifest coordinates are the
// correct anchor here. xp-cache shares egg-bazaar-02 with the keepsake
// (each claim still needs its own settled interact).
export const SUN_SHARD_PICKUP = { id: "shard-sun", target: "egg-bazaar-05", name: "Sun Shard", credits: 15, xp: 10 } as const;
export const LEAF_SHARD_PICKUP = { id: "shard-leaf", target: "egg-bazaar-06", name: "Leaf Shard", credits: 15, xp: 10 } as const;
export const EMBER_SHARD_PICKUP = { id: "shard-ember", target: "egg-bazaar-04", name: "Ember Shard", credits: 15, xp: 10 } as const;
export const STAR_SHARD_PICKUP = { id: "shard-star", target: "egg-bazaar-01", name: "Star Shard", credits: 15, xp: 10 } as const;
export const MOON_SHARD_PICKUP = { id: "shard-moon", target: "egg-soak-03", name: "Moon Shard", credits: 15, xp: 10 } as const;
export const LANTERN_PICKUP = { id: "seeker-lantern", target: "egg-soak-04", name: "Seeker Lantern", credits: 20, xp: 15 } as const;
export const KETTLE_PICKUP = { id: "kettle-of-rest", target: "tea-radio", name: "Kettle of Rest", credits: 20, xp: 15 } as const;
export const KEYCARD_PICKUP = { id: "terminal-keycard", target: "egg-soak-01", name: "Terminal Keycard", credits: 25, xp: 20 } as const;
export const GOLDEN_EGG_PICKUP = { id: "golden-egg", target: "egg-soak-02", name: "Golden Egg", credits: 50, xp: 25 } as const;
export const CREDIT_CACHE_PICKUP = { id: "credit-cache", target: "egg-bazaar-03", name: "Credit cache", credits: 10, xp: 5, perAgent: true } as const;
export const XP_CACHE_PICKUP = { id: "xp-cache", target: "egg-bazaar-02", name: "Verse XP cache", credits: 0, xp: 15, perAgent: true } as const;

export const PICKUPS = [PILOT_PICKUP, CABIN_PICKUP, MARKET_HALL_PICKUP,
  SUN_SHARD_PICKUP, LEAF_SHARD_PICKUP, EMBER_SHARD_PICKUP, STAR_SHARD_PICKUP, MOON_SHARD_PICKUP,
  LANTERN_PICKUP, KETTLE_PICKUP, KEYCARD_PICKUP, GOLDEN_EGG_PICKUP,
  CREDIT_CACHE_PICKUP, XP_CACHE_PICKUP] as const;
type Pickup = (typeof PICKUPS)[number];

export const PICKUP_POSITIONS: Record<Pickup["id"], readonly [number, number, number]> = {
  [PILOT_PICKUP.id]: EGGS[PILOT_PICKUP.target].position,
  [CABIN_PICKUP.id]: [-19, 0.48, 84],
  [MARKET_HALL_PICKUP.id]: [MARKET_HALL_SAMPLE.stand[0], MARKET_HALL_SAMPLE.floorY, MARKET_HALL_SAMPLE.stand[1]],
  [SUN_SHARD_PICKUP.id]: EGGS[SUN_SHARD_PICKUP.target].position,
  [LEAF_SHARD_PICKUP.id]: EGGS[LEAF_SHARD_PICKUP.target].position,
  [EMBER_SHARD_PICKUP.id]: EGGS[EMBER_SHARD_PICKUP.target].position,
  [STAR_SHARD_PICKUP.id]: EGGS[STAR_SHARD_PICKUP.target].position,
  [MOON_SHARD_PICKUP.id]: EGGS[MOON_SHARD_PICKUP.target].position,
  [LANTERN_PICKUP.id]: EGGS[LANTERN_PICKUP.target].position,
  [KETTLE_PICKUP.id]: [-21.04, 0.48, -75.9],
  [KEYCARD_PICKUP.id]: EGGS[KEYCARD_PICKUP.target].position,
  [GOLDEN_EGG_PICKUP.id]: EGGS[GOLDEN_EGG_PICKUP.target].position,
  [CREDIT_CACHE_PICKUP.id]: [-28.65, 0.2, -41.6],
  [XP_CACHE_PICKUP.id]: EGGS[XP_CACHE_PICKUP.target].position,
};

function claimKey(agentId: string, pickup: Pickup) {
  return "perAgent" in pickup ? `${pickup.id}:${agentId}` : pickup.id;
}

export async function ownsCabinTea(agentId: string) {
  const [item] = await db.select({ id: verseInventory.id }).from(versePickupClaims)
    .innerJoin(verseInventory, eq(verseInventory.id, versePickupClaims.itemId))
    .where(and(eq(versePickupClaims.pickupId, CABIN_PICKUP.id), eq(verseInventory.agentId, agentId)));
  return Boolean(item);
}

export async function progress(agentId: string, store: Pick<typeof db, "select"> = db) {
  const [totals] = await store.select({
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

export async function pickupReceipt(agentId: string, pickup: Pickup = PILOT_PICKUP) {
  const [claim] = await db.select().from(versePickupClaims).where(eq(versePickupClaims.pickupId, claimKey(agentId, pickup)));
  if (!claim) return null;
  return claim.agentId === agentId ? { itemId: claim.itemId, credits: pickup.credits, xp: pickup.xp } : false;
}

export async function awardPickup(agentId: string, pickup: Pickup = PILOT_PICKUP) {
  const pickupId = claimKey(agentId, pickup);
  return db.transaction(async (tx) => {
    const [entry] = await tx.insert(versePickupClaims).values({ pickupId, agentId })
      .onConflictDoNothing().returning();
    if (!entry) {
      const [existing] = await tx.select().from(versePickupClaims).where(eq(versePickupClaims.pickupId, pickupId));
      return existing?.agentId === agentId
        ? { itemId: existing.itemId, credits: pickup.credits, xp: pickup.xp }
        : false;
    }
    const [item] = await tx.insert(verseInventory).values({ agentId, name: pickup.name }).returning();
    await tx.update(versePickupClaims).set({ itemId: item.id }).where(eq(versePickupClaims.pickupId, entry.pickupId));
    await tx.insert(verseProgressEvents).values({
      agentId, kind: "pickup", source: pickup.id, credits: pickup.credits, xp: pickup.xp,
    });
    return { itemId: item.id, credits: pickup.credits, xp: pickup.xp };
  });
}
