import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agents, verseInventory, verseProgressEvents, verseSaleOffers } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { progress } from "./verseProgress";
import { findWant, getWants, satisfyWant } from "./agentEconomy";
import { vitalsChanged } from "./vitalsPush";

// Agent-economy Phase 4 (Nov 25 2026): the agent-to-agent sales path as a
// service. The buy transaction below is the verse-economy REST one
// (routes/verseEconomy.ts POST /verse/sales/:id/buy), extracted verbatim
// so the REST route and the agent MCP surface share ONE implementation —
// the plan's reuse-first rule: the sales route proved sufficient in
// testing (world/agentEconomyWants.test.ts), so no direct offer/accept
// machinery was built. Invariants, unchanged from the route: ONE
// transaction; the offer row is locked FOR UPDATE; both agents are
// locked in UUID order FOR NO KEY UPDATE (reciprocal sales cannot
// deadlock, and one buyer's spends serialize — the double-spend race);
// the credits check reads progress() inside the transaction; the item
// moves only at the listed revision; seller +price / buyer −price land
// as ledger rows keyed by the offer id; a repeat buy by the same buyer
// returns the original receipt.

export interface OpenSaleOffer { id: string; itemName: string; price: number; sellerId: string | null }

/** The open sales board: offers whose item the seller still owns at the
 *  listed revision (the GET /verse/sales read, as a service). */
export async function listOpenSaleOffers(store: Pick<typeof db, "select"> = db): Promise<OpenSaleOffer[]> {
  return store.select({
    id: verseSaleOffers.id, itemName: verseSaleOffers.itemName, price: verseSaleOffers.price,
    sellerId: verseSaleOffers.sellerId,
  }).from(verseSaleOffers).innerJoin(verseInventory, and(
    eq(verseInventory.id, verseSaleOffers.itemId),
    eq(verseInventory.agentId, verseSaleOffers.sellerId),
    eq(verseInventory.revision, verseSaleOffers.itemRevision),
  )).where(isNull(verseSaleOffers.purchasedAt))
    .orderBy(asc(verseSaleOffers.id)).limit(100);
}

export type BuySaleOfferResult =
  | { ok: true; receipt: typeof verseSaleOffers.$inferSelect }
  | { ok: false; error: "offer_not_found" | "offer_closed" | "stale_offer" | "own_offer" | "insufficient_credits"; status: 404 | 409 };

/** Buy one open sales offer (the REST buy, as a service). */
export async function buySaleOffer(buyerId: string, offerId: string): Promise<BuySaleOfferResult> {
  return db.transaction(async (tx) => {
    const [offer] = await tx.select().from(verseSaleOffers).where(eq(verseSaleOffers.id, offerId)).for("update");
    if (!offer) return { ok: false, error: "offer_not_found", status: 404 } as const;
    if (offer.purchasedAt) return offer.buyerId === buyerId
      ? { ok: true, receipt: offer } as const
      : { ok: false, error: "offer_closed", status: 409 } as const;
    const { sellerId, itemId } = offer;
    if (!sellerId || !itemId) return { ok: false, error: "stale_offer", status: 409 } as const;
    if (buyerId === sellerId) return { ok: false, error: "own_offer", status: 409 } as const;
    // Serialize spending across offers. Lock both agents in UUID order for reciprocal sales.
    const parties = await tx.select({ id: agents.id }).from(agents).where(inArray(agents.id, [buyerId, sellerId]))
      .orderBy(asc(agents.id)).for("no key update");
    if (parties.length !== 2) return { ok: false, error: "stale_offer", status: 409 } as const;
    if ((await progress(buyerId, tx)).credits < offer.price) return { ok: false, error: "insufficient_credits", status: 409 } as const;
    const [moved] = await tx.update(verseInventory).set({ agentId: buyerId, revision: sql`${verseInventory.revision} + 1` })
      .where(and(eq(verseInventory.id, itemId), eq(verseInventory.agentId, sellerId),
        eq(verseInventory.revision, offer.itemRevision))).returning({ id: verseInventory.id });
    if (!moved) return { ok: false, error: "stale_offer", status: 409 } as const;
    await tx.insert(verseProgressEvents).values([
      { agentId: sellerId, kind: "sale", source: offer.id, credits: offer.price },
      { agentId: buyerId, kind: "sale", source: offer.id, credits: -offer.price },
    ]);
    vitalsChanged(sellerId);
    vitalsChanged(buyerId);
    const [receipt] = await tx.update(verseSaleOffers).set({ buyerId, purchasedAt: sql`clock_timestamp()` })
      .where(eq(verseSaleOffers.id, offer.id)).returning();
    return { ok: true, receipt } as const;
  });
}

export type BuyListingForWantResult =
  | BuySaleOfferResult
  | { ok: false; error: "no_matching_want" | "above_max_price" };

/** The want-driven trade path (world_buy with a listing target): a
 *  purchase happens BECAUSE a want drives it. An agent with no want
 *  naming the listed item is refused `no_matching_want` and nothing
 *  moves — the collect-bag hunt's zero trades were a missing-wants
 *  failure, and this path never pushes a purchase on a want-less agent.
 *  A want whose maxPrice is below the listing price is refused
 *  `above_max_price` (maxPrice is the most the agent will pay). On
 *  success the want is satisfied and cleared. Already-purchased offers
 *  defer to buySaleOffer, so a retry of the buyer's own completed
 *  purchase still returns its receipt. */
export async function buyListingForWant(buyerId: string, offerId: string): Promise<BuyListingForWantResult> {
  const [offer] = await db.select().from(verseSaleOffers).where(eq(verseSaleOffers.id, offerId));
  if (offer && !offer.purchasedAt) {
    const want = findWant(await getWants(buyerId), offer.itemName);
    if (!want) return { ok: false, error: "no_matching_want" };
    if (want.maxPrice !== undefined && offer.price > want.maxPrice) {
      return { ok: false, error: "above_max_price" };
    }
  }
  const result = await buySaleOffer(buyerId, offerId);
  if (result.ok) await satisfyWant(buyerId, result.receipt.itemName);
  return result;
}
