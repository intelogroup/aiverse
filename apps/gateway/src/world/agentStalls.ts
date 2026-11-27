import { and, asc, eq, sql } from "drizzle-orm";
import { agents, verseInventory, verseProgressEvents, verseStallStock, verseStalls } from "@aiverse/shared/schema";
import { MARKET_HALL_SAMPLE } from "@aiverse/shared/marketHall";
import { db } from "../db/client";
import { progress } from "./verseProgress";
import { satisfyWant } from "./agentEconomy";
import { vitalsChanged } from "./vitalsPush";

// Agent-economy Phase 3 (Nov 25 2026): bazaar stalls and bars as world
// fixtures with stock + prices, and the world_buy purchase path.
//
// The fixtures are ported from the experiment rig, not its tree: the
// Market Hall bakery stand (the live sample's own position, shared via
// @aiverse/shared/marketHall) and the Tea House bar at shop-102 (the
// open-day rig's food destination). Seed data lives in code and is
// materialized idempotently on first read/buy — no migration-seed
// ordering problem, and every environment (prod, tests) gets the same
// stalls. Stock/price EDITS after seeding are the DB rows' own business:
// ensureStalls never overwrites an existing row.
//
// Purchases reuse the verse-economy sales buy invariants (routes/
// verseEconomy.ts): ONE transaction; the stock row is locked FOR UPDATE;
// the buyer's agent row is locked FOR NO KEY UPDATE so concurrent spends
// by the same agent serialize (two buys with funds for one cannot both
// pass the balance check — the double-spend race); the credits check reads
// progress() inside the transaction; the stock decrement is conditional
// on stock > 0. The buyer's debit is a verse_progress_events row whose
// source is the new inventory item's id — unique per purchase, so the
// ledger's (agent, kind, source) PK never swallows a repeat buy. An
// agent-owned stall is credited the price (kind stall_sale, same source);
// the seeded fixtures are unowned, so their takings sink to the fixture.
// Sales listings (verse_sale_offers) remain the agent-to-agent path.

export interface StallSeedItem { name: string; price: number; stock: number }
export interface StallSeed {
  id: string; name: string; place: string; x: number; z: number; items: StallSeedItem[];
}

export const STALL_SEED: StallSeed[] = [
  {
    id: "market-hall-bakery",
    name: "Market Hall Bakery",
    place: MARKET_HALL_SAMPLE.room,
    x: MARKET_HALL_SAMPLE.stand[0],
    z: MARKET_HALL_SAMPLE.stand[1],
    items: [
      { name: MARKET_HALL_SAMPLE.name, price: 5, stock: 100 },
      { name: "Fresh bread loaf", price: 8, stock: 50 },
      { name: "Fruit juice", price: 6, stock: 50 },
    ],
  },
  {
    id: "tea-house-bar",
    name: "Tea House Bar",
    place: "shop-102",
    x: -25,
    z: -78.5,
    items: [
      { name: "Tea house drink", price: 7, stock: 50 },
      { name: "Herbal soup", price: 10, stock: 30 },
      { name: "Market Hall bakery sample", price: 5, stock: 20 },
    ],
  },
];

type Store = Pick<typeof db, "select" | "insert">;

/** Materialize the seeded fixtures (stalls + opening stock) if absent. */
export async function ensureStalls(store: Store = db): Promise<void> {
  for (const seed of STALL_SEED) {
    await store.insert(verseStalls).values({
      id: seed.id, name: seed.name, place: seed.place, x: seed.x, z: seed.z,
    }).onConflictDoNothing();
    for (const item of seed.items) {
      await store.insert(verseStallStock).values({
        stallId: seed.id, itemName: item.name, price: item.price, stock: item.stock,
      }).onConflictDoNothing();
    }
  }
}

export interface StallListing {
  id: string;
  name: string;
  place: string | null;
  items: { name: string; price: number; stock: number }[];
}

export async function listStalls(store: Store = db): Promise<StallListing[]> {
  await ensureStalls(store);
  const stalls = await store.select().from(verseStalls).orderBy(asc(verseStalls.id));
  const stock = await store.select().from(verseStallStock).orderBy(asc(verseStallStock.itemName));
  return stalls.map((stall) => ({
    id: stall.id,
    name: stall.name,
    place: stall.place,
    items: stock.filter((s) => s.stallId === stall.id)
      .map((s) => ({ name: s.itemName, price: s.price, stock: s.stock })),
  }));
}

function perceptionRangeM(): number {
  const value = Number(process.env.VERSE_STALL_PERCEPTION_M);
  return Number.isFinite(value) && value > 0 ? value : 25;
}

/** Stalls an agent can see prices for: within perception range of the
 *  observed body position, or at the observed place/room when the observe
 *  carried no usable position for that stall. */
export async function nearbyStalls(
  at: { x?: unknown; z?: unknown; placeId?: string | null },
  store: Store = db,
): Promise<StallListing[]> {
  const all = await listStalls(store);
  const range = perceptionRangeM();
  const hasPos = typeof at.x === "number" && Number.isFinite(at.x) && typeof at.z === "number" && Number.isFinite(at.z);
  return all.filter((stall) => {
    if (at.placeId && stall.place === at.placeId) return true;
    if (!hasPos) return false;
    const seed = STALL_SEED.find((s) => s.id === stall.id);
    if (!seed) return false;
    return Math.hypot(seed.x - (at.x as number), seed.z - (at.z as number)) <= range;
  });
}

export type BuyFromStallResult =
  | { ok: true; item: { id: string; name: string }; stall: { id: string; name: string }; price: number; credits: number; stock: number }
  | { ok: false; error: "stall_not_found" | "item_not_stocked" | "out_of_stock" | "insufficient_credits" };

/** Buy one stocked item from a stall (world_buy). See the header for the
 *  transaction invariants. `stallRef` is a stall id or exact name;
 *  `itemRef` is an item name or a stock row id. */
export async function buyFromStall(agentId: string, stallRef: string, itemRef: string): Promise<BuyFromStallResult> {
  await ensureStalls();
  const result = await db.transaction(async (tx) => {
    const stalls = await tx.select().from(verseStalls);
    const stall = stalls.find((s) => s.id === stallRef) ?? stalls.find((s) => s.name === stallRef);
    if (!stall) return { ok: false, error: "stall_not_found" } as const;
    const stockRows = await tx.select().from(verseStallStock)
      .where(eq(verseStallStock.stallId, stall.id)).for("update");
    const line = stockRows.find((s) => s.itemName === itemRef) ?? stockRows.find((s) => s.id === itemRef);
    if (!line) return { ok: false, error: "item_not_stocked" } as const;
    if (line.stock <= 0) return { ok: false, error: "out_of_stock" } as const;
    // Serialize this buyer's spending across every stall and sale (the
    // sales buy locks the same agent row the same way).
    const [buyer] = await tx.select({ id: agents.id }).from(agents)
      .where(eq(agents.id, agentId)).for("no key update");
    if (!buyer) return { ok: false, error: "stall_not_found" } as const;
    if ((await progress(agentId, tx)).credits < line.price) {
      return { ok: false, error: "insufficient_credits" } as const;
    }
    const [decremented] = await tx.update(verseStallStock)
      .set({ stock: sql`${verseStallStock.stock} - 1` })
      .where(and(eq(verseStallStock.id, line.id), sql`${verseStallStock.stock} > 0`))
      .returning({ stock: verseStallStock.stock });
    if (!decremented) return { ok: false, error: "out_of_stock" } as const;
    const [item] = await tx.insert(verseInventory).values({ agentId, name: line.itemName }).returning();
    const events: (typeof verseProgressEvents.$inferInsert)[] = [
      { agentId, kind: "stall_purchase", source: item.id, credits: -line.price },
    ];
    if (stall.ownerAgentId && stall.ownerAgentId !== agentId) {
      events.push({ agentId: stall.ownerAgentId, kind: "stall_sale", source: item.id, credits: line.price });
    }
    await tx.insert(verseProgressEvents).values(events);
    for (const e of events) vitalsChanged(e.agentId);
    const credits = (await progress(agentId, tx)).credits;
    return {
      ok: true,
      item: { id: item.id, name: item.name },
      stall: { id: stall.id, name: stall.name },
      price: line.price,
      credits: Math.trunc(credits),
      stock: decremented.stock,
    } as const;
  });
  // Phase 4: buying a wanted item satisfies its want (same semantics as
  // the listing path) — a filled want never drives a second purchase.
  if (result.ok) await satisfyWant(agentId, result.item.name);
  return result;
}
