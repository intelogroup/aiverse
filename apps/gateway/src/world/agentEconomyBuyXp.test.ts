import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents, owners, verseInventory, verseProgressEvents, verseStallStock, verseStalls } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { progress } from "./verseProgress";
import { awardMoveXp, awardPlaceXp, claimStipends, placeXpForVisit } from "./agentEconomy";
import { buyFromStall, ensureStalls, listStalls, nearbyStalls, STALL_SEED } from "./agentStalls";

// Agent-economy Phase 3 at the ledger layer: stall buys move credits + items
// atomically, stipends are idempotent, and XP awards land per action class
// with diminishing returns per place. Real DB (aiverse_test), like the
// Phase 1/2 suites.

async function createAgentRow() {
  const [owner] = await db.insert(owners).values({
    email: `economy-p3-${randomUUID()}@example.com`, passwordHash: "unused-in-test",
  }).returning();
  const [agent] = await db.insert(agents).values({
    ownerId: owner.id, name: `P3-${randomUUID().slice(0, 8)}`, apiKeyHash: randomUUID(),
  }).returning();
  return agent;
}

async function grantCredits(agentId: string, credits: number) {
  await db.insert(verseProgressEvents).values({
    agentId, kind: "grant", source: `test-grant-${randomUUID()}`, credits,
  });
}

const BAKERY = STALL_SEED[0];

describe("stall fixtures", () => {
  test("ensureStalls materializes the seed idempotently, with stock + prices", async () => {
    await ensureStalls();
    await ensureStalls();
    const stalls = await listStalls();
    for (const seed of STALL_SEED) {
      const stall = stalls.find((s) => s.id === seed.id);
      expect(stall).toBeDefined();
      expect(stall!.name).toBe(seed.name);
      expect(stall!.items.map((i) => i.name).sort()).toEqual(seed.items.map((i) => i.name).sort());
      for (const item of seed.items) {
        const listed = stall!.items.find((i) => i.name === item.name)!;
        expect(listed.price).toBe(item.price);
        expect(listed.stock).toBeGreaterThan(0);
      }
    }
    const rows = await db.select().from(verseStalls);
    expect(rows.filter((r) => STALL_SEED.some((s) => s.id === r.id))).toHaveLength(STALL_SEED.length);
  });

  test("nearbyStalls filters by perception range and by place", async () => {
    await ensureStalls();
    const atBakery = await nearbyStalls({ x: BAKERY.x, z: BAKERY.z });
    expect(atBakery.map((s) => s.id)).toContain(BAKERY.id);
    const far = await nearbyStalls({ x: BAKERY.x + 500, z: BAKERY.z + 500 });
    expect(far.map((s) => s.id)).not.toContain(BAKERY.id);
    const byPlace = await nearbyStalls({ placeId: BAKERY.place });
    expect(byPlace.map((s) => s.id)).toContain(BAKERY.id);
  });
});

describe("buyFromStall", () => {
  test("buy success: credits down by price, item in bag, stock down by one", async () => {
    await ensureStalls();
    const agent = await createAgentRow();
    await grantCredits(agent.id, 100);
    const item = BAKERY.items[0];
    const [stockBefore] = await db.select().from(verseStallStock)
      .where(eq(verseStallStock.stallId, BAKERY.id));
    const result = await buyFromStall(agent.id, BAKERY.id, item.name);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.price).toBe(item.price);
    expect(result.item.name).toBe(item.name);
    expect((await progress(agent.id)).credits).toBe(100 - item.price);
    const bag = await db.select().from(verseInventory).where(eq(verseInventory.agentId, agent.id));
    expect(bag.map((b) => b.id)).toContain(result.item.id);
    const [stockAfter] = await db.select().from(verseStallStock)
      .where(eq(verseStallStock.stallId, BAKERY.id));
    expect(stockAfter.stock).toBe(stockBefore.stock - 1);
  });

  test("insufficient funds: refused, no item, no stock change, balance untouched", async () => {
    await ensureStalls();
    const agent = await createAgentRow();
    await grantCredits(agent.id, 2); // cheapest seed item costs more
    const item = BAKERY.items[0];
    const [stockBefore] = await db.select().from(verseStallStock)
      .where(eq(verseStallStock.stallId, BAKERY.id));
    const result = await buyFromStall(agent.id, BAKERY.id, item.name);
    expect(result).toEqual({ ok: false, error: "insufficient_credits" });
    expect((await progress(agent.id)).credits).toBe(2);
    expect(await db.select().from(verseInventory).where(eq(verseInventory.agentId, agent.id))).toHaveLength(0);
    const [stockAfter] = await db.select().from(verseStallStock)
      .where(eq(verseStallStock.stallId, BAKERY.id));
    expect(stockAfter.stock).toBe(stockBefore.stock);
  });

  test("unknown stall / unstocked item are refused by name", async () => {
    const agent = await createAgentRow();
    await grantCredits(agent.id, 100);
    expect(await buyFromStall(agent.id, "no-such-stall", "x")).toEqual({ ok: false, error: "stall_not_found" });
    expect(await buyFromStall(agent.id, BAKERY.id, "Unstocked Widget")).toEqual({ ok: false, error: "item_not_stocked" });
  });

  test("double-spend race: two concurrent buys, funds for one — exactly one succeeds", async () => {
    await ensureStalls();
    const agent = await createAgentRow();
    const item = BAKERY.items[0];
    await grantCredits(agent.id, item.price); // exactly one purchase worth
    const results = await Promise.all([
      buyFromStall(agent.id, BAKERY.id, item.name),
      buyFromStall(agent.id, BAKERY.id, item.name),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "insufficient_credits")).toHaveLength(1);
    expect((await progress(agent.id)).credits).toBe(0);
    expect(await db.select().from(verseInventory).where(eq(verseInventory.agentId, agent.id))).toHaveLength(1);
  });

  test("repeat buys of the same item both land (ledger source is per-purchase)", async () => {
    await ensureStalls();
    const agent = await createAgentRow();
    const item = BAKERY.items[0];
    await grantCredits(agent.id, item.price * 2);
    expect((await buyFromStall(agent.id, BAKERY.id, item.name)).ok).toBe(true);
    expect((await buyFromStall(agent.id, BAKERY.id, item.name)).ok).toBe(true);
    expect((await progress(agent.id)).credits).toBe(0);
    expect(await db.select().from(verseInventory).where(eq(verseInventory.agentId, agent.id))).toHaveLength(2);
  });
});

describe("claimStipends", () => {
  test("first-ever claim grants 1,000 credits + login XP, exactly once", async () => {
    const agent = await createAgentRow();
    const first = await claimStipends(agent.id, new Date("2026-11-25T12:00:00Z"));
    expect(first).toEqual({ granted: "first_login", credits: 1000, xp: 5 });
    expect(await progress(agent.id)).toEqual({ credits: 1000, xp: 5 });
    // Same day again: the daily grant does not stack on the first-login day.
    const again = await claimStipends(agent.id, new Date("2026-11-25T18:00:00Z"));
    expect(again.granted).toBeNull();
    expect(await progress(agent.id)).toEqual({ credits: 1000, xp: 5 });
  });

  test("daily grant: 200 credits + 2 XP, once per UTC day, again the next day", async () => {
    const agent = await createAgentRow();
    await claimStipends(agent.id, new Date("2026-11-25T12:00:00Z"));
    const day2 = await claimStipends(agent.id, new Date("2026-11-26T09:00:00Z"));
    expect(day2).toEqual({ granted: "daily", credits: 200, xp: 2 });
    const day2again = await claimStipends(agent.id, new Date("2026-11-26T23:59:00Z"));
    expect(day2again.granted).toBeNull();
    const day3 = await claimStipends(agent.id, new Date("2026-11-27T00:01:00Z"));
    expect(day3).toEqual({ granted: "daily", credits: 200, xp: 2 });
    expect(await progress(agent.id)).toEqual({ credits: 1400, xp: 9 });
  });

  test("concurrent first claims grant once", async () => {
    const agent = await createAgentRow();
    const now = new Date("2026-11-25T12:00:00Z");
    const results = await Promise.all([claimStipends(agent.id, now), claimStipends(agent.id, now)]);
    expect(results.filter((r) => r.granted === "first_login")).toHaveLength(1);
    expect((await progress(agent.id)).credits).toBe(1000);
  });
});

describe("XP awards", () => {
  test("placeXpForVisit curve diminishes to zero", () => {
    expect([0, 1, 2, 3, 4, 10].map(placeXpForVisit)).toEqual([5, 2, 1, 0, 0, 0]);
  });

  test("awardPlaceXp pays the curve per place and caps the total (no first-place farming)", async () => {
    const agent = await createAgentRow();
    const place = `place-${randomUUID().slice(0, 8)}`;
    expect((await awardPlaceXp(agent.id, place, "visit-1")).xp).toBe(5);
    // A second poll inside the SAME visit is not a new visit: no award.
    expect((await awardPlaceXp(agent.id, place, "visit-1")).xp).toBe(0);
    expect((await awardPlaceXp(agent.id, place, "visit-2")).xp).toBe(2);
    expect((await awardPlaceXp(agent.id, place, "visit-3")).xp).toBe(1);
    expect((await awardPlaceXp(agent.id, place, "visit-4")).xp).toBe(0);
    expect((await awardPlaceXp(agent.id, place, "visit-5")).xp).toBe(0);
    expect((await progress(agent.id)).xp).toBe(8);
    // A different place starts its own curve.
    expect((await awardPlaceXp(agent.id, `${place}-b`, "visit-1")).xp).toBe(5);
  });

  test("awardMoveXp pays 1 XP per act id, and a replay of the same act pays nothing", async () => {
    const agent = await createAgentRow();
    const actId = `act-${randomUUID().slice(0, 8)}`;
    expect(await awardMoveXp(agent.id, actId)).toBe(1);
    expect(await awardMoveXp(agent.id, actId)).toBe(0);
    expect(await awardMoveXp(agent.id, `${actId}-2`)).toBe(1);
    expect((await progress(agent.id)).xp).toBe(2);
  });
});
