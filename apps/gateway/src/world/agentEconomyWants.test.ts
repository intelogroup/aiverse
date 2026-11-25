import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents, owners, verseInventory, verseProgressEvents, verseSaleOffers } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { progress } from "./verseProgress";
import { clearWants, getAgentEconomyState, getWants, satisfyWant, setWants, wantMatches } from "./agentEconomy";
import { buyListingForWant, buySaleOffer, listOpenSaleOffers } from "./agentSales";

// Agent-economy Phase 4 at the service layer: wants are writable by their
// agent, and the agent-to-agent sales path completes a purchase BECAUSE a
// want drives it. The sales buy transaction is the Phase ≤3 REST one,
// extracted into world/agentSales.ts — these tests are the evidence that
// the existing sales route is sufficient and no offer/accept machinery
// was needed. Real DB (aiverse_test), like the Phase 1–3 suites.

async function createAgentRow() {
  const [owner] = await db.insert(owners).values({
    email: `economy-p4-${randomUUID()}@example.com`, passwordHash: "unused-in-test",
  }).returning();
  const [agent] = await db.insert(agents).values({
    ownerId: owner.id, name: `P4-${randomUUID().slice(0, 8)}`, apiKeyHash: randomUUID(),
  }).returning();
  return agent;
}

async function grantCredits(agentId: string, credits: number) {
  await db.insert(verseProgressEvents).values({
    agentId, kind: "grant", source: `test-grant-${randomUUID()}`, credits,
  });
}

async function listItem(sellerId: string, name: string, price: number) {
  const [item] = await db.insert(verseInventory).values({ agentId: sellerId, name }).returning();
  const [offer] = await db.insert(verseSaleOffers).values({
    itemId: item.id, itemName: item.name, itemRevision: item.revision, sellerId, price,
  }).returning();
  return { item, offer };
}

describe("wants write path", () => {
  test("set / read / clear round-trip through the agent state row", async () => {
    const agent = await createAgentRow();
    expect(await getWants(agent.id)).toEqual([]);
    const set = await setWants(agent.id, [{ item: "Golden Egg" }, { item: "Brass Key", maxPrice: 40 }]);
    expect(set).toEqual({ ok: true, wants: [{ item: "Golden Egg" }, { item: "Brass Key", maxPrice: 40 }] });
    // The self block (world_observe / agent_whoami) reads the same wants.
    expect((await getAgentEconomyState(agent.id)).wants).toEqual([
      { item: "Golden Egg" }, { item: "Brass Key", maxPrice: 40 },
    ]);
    // Set REPLACES the whole list.
    await setWants(agent.id, [{ item: "Silver Bell", maxPrice: 5 }]);
    expect(await getWants(agent.id)).toEqual([{ item: "Silver Bell", maxPrice: 5 }]);
    // Clear one by name; clear the rest with no name.
    expect(await clearWants(agent.id, "silver bell")).toEqual([]);
    await setWants(agent.id, [{ item: "A" }, { item: "B" }]);
    expect(await clearWants(agent.id)).toEqual([]);
    expect((await getAgentEconomyState(agent.id)).wants).toEqual([]);
  });

  test("invalid wants are refused and the stored list is untouched", async () => {
    const agent = await createAgentRow();
    await setWants(agent.id, [{ item: "Kept" }]);
    for (const bad of [
      [{ item: "" }],
      [{ item: "   " }],
      [{ item: "X", maxPrice: 0 }],
      [{ item: "X", maxPrice: -3 }],
      [{ item: "X", maxPrice: 2.5 }],
      [{ item: 42 }],
      ["not-an-object"],
    ]) {
      const res = await setWants(agent.id, bad as any);
      expect(res.ok).toBe(false);
    }
    expect(await getWants(agent.id)).toEqual([{ item: "Kept" }]);
  });

  test("duplicate items collapse to the first entry", async () => {
    const agent = await createAgentRow();
    const res = await setWants(agent.id, [
      { item: "Brass Key", maxPrice: 10 }, { item: "brass key", maxPrice: 99 },
    ]);
    expect(res).toEqual({ ok: true, wants: [{ item: "Brass Key", maxPrice: 10 }] });
  });
});

describe("wantMatches", () => {
  test("name match is case-insensitive; maxPrice is a hard ceiling", () => {
    const wants = [{ item: "Brass Key", maxPrice: 40 }, { item: "Golden Egg" }];
    expect(wantMatches(wants, "brass key", 40)).toBe(true);
    expect(wantMatches(wants, "Brass Key", 41)).toBe(false);
    expect(wantMatches(wants, "Golden Egg", 99999)).toBe(true);
    expect(wantMatches(wants, "Silver Bell", 1)).toBe(false);
    expect(wantMatches([], "Brass Key", 1)).toBe(false);
  });
});

describe("want-driven sales purchase", () => {
  test("want → matching listing → purchase completes: credits + item move, want satisfied", async () => {
    const seller = await createAgentRow();
    const buyer = await createAgentRow();
    await grantCredits(buyer.id, 100);
    const { item, offer } = await listItem(seller.id, "Brass Key", 30);
    await setWants(buyer.id, [{ item: "Brass Key", maxPrice: 40 }, { item: "Other", maxPrice: 1 }]);

    const result = await buyListingForWant(buyer.id, offer.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.id).toBe(offer.id);
    expect((await progress(buyer.id)).credits).toBe(70);
    expect((await progress(seller.id)).credits).toBe(30);
    const [moved] = await db.select().from(verseInventory).where(eq(verseInventory.id, item.id));
    expect(moved.agentId).toBe(buyer.id);
    expect(moved.revision).toBe(1);
    // The satisfied want is cleared; the unrelated want stays.
    expect(await getWants(buyer.id)).toEqual([{ item: "Other", maxPrice: 1 }]);
    // The offer is closed and leaves the open board.
    expect((await listOpenSaleOffers()).map((o) => o.id)).not.toContain(offer.id);
  });

  test("maxPrice respected: a listing above the want's ceiling does not complete and is not a match", async () => {
    const seller = await createAgentRow();
    const buyer = await createAgentRow();
    await grantCredits(buyer.id, 1000);
    const { item, offer } = await listItem(seller.id, "Golden Egg", 500);
    await setWants(buyer.id, [{ item: "Golden Egg", maxPrice: 100 }]);

    const open = await listOpenSaleOffers();
    const listed = open.find((o) => o.id === offer.id)!;
    expect(wantMatches(await getWants(buyer.id), listed.itemName, listed.price)).toBe(false);

    const result = await buyListingForWant(buyer.id, offer.id);
    expect(result).toEqual({ ok: false, error: "above_max_price" });
    expect((await progress(buyer.id)).credits).toBe(1000);
    expect((await progress(seller.id)).credits).toBe(0);
    const [still] = await db.select().from(verseInventory).where(eq(verseInventory.id, item.id));
    expect(still.agentId).toBe(seller.id);
    // The want survives — it is unmet, not satisfied.
    expect(await getWants(buyer.id)).toEqual([{ item: "Golden Egg", maxPrice: 100 }]);
  });

  test("NO-WANT REGRESSION: an agent with no wants does not trade (the hunt's zero-trade case)", async () => {
    const seller = await createAgentRow();
    const buyer = await createAgentRow();
    await grantCredits(buyer.id, 100);
    const { item, offer } = await listItem(seller.id, "Shiny Relic", 10);
    expect(await getWants(buyer.id)).toEqual([]);

    const result = await buyListingForWant(buyer.id, offer.id);
    expect(result).toEqual({ ok: false, error: "no_matching_want" });
    expect((await progress(buyer.id)).credits).toBe(100);
    expect((await progress(seller.id)).credits).toBe(0);
    const [still] = await db.select().from(verseInventory).where(eq(verseInventory.id, item.id));
    expect(still.agentId).toBe(seller.id);
    expect((await listOpenSaleOffers()).map((o) => o.id)).toContain(offer.id);
  });

  test("a want for a DIFFERENT item does not drive this purchase", async () => {
    const seller = await createAgentRow();
    const buyer = await createAgentRow();
    await grantCredits(buyer.id, 100);
    const { offer } = await listItem(seller.id, "Brass Key", 10);
    await setWants(buyer.id, [{ item: "Silver Bell" }]);
    expect(await buyListingForWant(buyer.id, offer.id)).toEqual({ ok: false, error: "no_matching_want" });
  });
});

describe("buySaleOffer (the extracted REST sales transaction)", () => {
  test("direct buy keeps the REST invariants: own offer and insufficient funds refused", async () => {
    const seller = await createAgentRow();
    const broke = await createAgentRow();
    const { offer } = await listItem(seller.id, "Market bowl", 4);
    expect(await buySaleOffer(seller.id, offer.id)).toEqual({ ok: false, error: "own_offer", status: 409 });
    expect(await buySaleOffer(broke.id, offer.id)).toEqual({ ok: false, error: "insufficient_credits", status: 409 });
    expect(await buySaleOffer(broke.id, randomUUID())).toEqual({ ok: false, error: "offer_not_found", status: 404 });
  });

  test("satisfyWant removes only the matching want", async () => {
    const agent = await createAgentRow();
    await setWants(agent.id, [{ item: "Brass Key" }, { item: "Golden Egg" }]);
    expect(await satisfyWant(agent.id, "brass key")).toEqual([{ item: "Golden Egg" }]);
    expect(await satisfyWant(agent.id, "Not Wanted")).toEqual([{ item: "Golden Egg" }]);
  });
});
