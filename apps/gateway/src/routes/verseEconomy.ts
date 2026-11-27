import { randomInt } from "node:crypto";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { agents, agentVisits, verseBounties, verseBountyClaims, verseInventory, verseAgentState, verseProgressEvents, verseSaleOffers } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { adminAuth } from "../middleware/adminAuth";
import { agentAuth } from "../middleware/agentAuth";
import { ownerAuth } from "../middleware/ownerAuth";
import { progress } from "../world/verseProgress";
import { buySaleOffer } from "../world/agentSales";
import { loadOwnedAgent } from "./ownersShared";

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(120);
const transfer = z.object({ toAgentId: uuid, revision: z.number().int().min(0).max(2_147_483_646) }).strict();
const createBounty = z.object({ title: name, rewardName: name, windowSeconds: z.number().int().min(1).max(3600).default(60) }).strict();
const grant = z.object({ agentId: uuid, name }).strict();

const saleOffer = z.object({ itemId: uuid, revision: transfer.shape.revision, price: z.number().int().min(1).max(2_147_483_647) }).strict();
const salesEnabled = () => process.env.AIVERSE_VERSE_PROGRESS === "1";

export const verseEconomyRoute = new Hono<{ Variables: { agentId: string; ownerId: string } }>();

function listInventory(agentId: string, after?: string) {
  return db.select().from(verseInventory)
    .where(and(eq(verseInventory.agentId, agentId), after ? gt(verseInventory.id, after) : undefined))
    .orderBy(asc(verseInventory.id)).limit(100);
}

async function listReceipts(agentId: string) {
  const rows = await db.select({
    id: verseSaleOffers.id, itemName: verseSaleOffers.itemName, price: verseSaleOffers.price,
    buyerId: verseSaleOffers.buyerId, purchasedAt: verseSaleOffers.purchasedAt,
  }).from(verseSaleOffers).where(and(isNotNull(verseSaleOffers.purchasedAt),
    or(eq(verseSaleOffers.buyerId, agentId), eq(verseSaleOffers.sellerId, agentId))))
    .orderBy(desc(verseSaleOffers.purchasedAt), desc(verseSaleOffers.id)).limit(20);
  return rows.map(({ buyerId, ...receipt }) => ({ ...receipt, side: buyerId === agentId ? "bought" : "sold" }));
}

verseEconomyRoute.get("/verse/inventory", agentAuth, async (c) => {
  const after = uuid.optional().safeParse(c.req.query("after"));
  if (!after.success) return c.json({ error: "invalid_cursor" }, 400);
  return c.json({ items: await listInventory(c.get("agentId"), after.data) });
});

verseEconomyRoute.get("/owners/agents/:id/inventory", ownerAuth, async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const after = uuid.optional().safeParse(c.req.query("after"));
  if (!id.success || !after.success) return c.json({ error: "invalid_request" }, 400);
  const agent = await loadOwnedAgent(c.get("ownerId"), id.data);
  if (!agent) return c.json({ error: "not_found" }, 404);
  const enabled = salesEnabled();
  const [items, totals, receipts, [state]] = await Promise.all([listInventory(agent.id, after.data),
    enabled ? progress(agent.id) : null, enabled && !after.data ? listReceipts(agent.id) : null,
    db.select({ energy: verseAgentState.energy }).from(verseAgentState).where(eq(verseAgentState.agentId, agent.id))]);
  return c.json({ items, energy: state?.energy ?? 100, ...(totals ? { progress: totals } : {}), ...(receipts ? { receipts } : {}) });
});

verseEconomyRoute.post("/admin/verse/inventory", adminAuth, async (c) => {
  const body = grant.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_item" }, 400);
  const [item] = await db.transaction(async (tx) => {
    const [agent] = await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, body.data.agentId)).for("key share");
    return agent ? tx.insert(verseInventory).values(body.data).returning() : [];
  });
  return item ? c.json({ item }, 201) : c.json({ error: "agent_not_found" }, 404);
});

verseEconomyRoute.post("/verse/inventory/:id/transfer", agentAuth, async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const body = transfer.safeParse(await c.req.json().catch(() => null));
  const agentId = c.get("agentId");
  if (!id.success || !body.success || body.data.toAgentId === agentId) return c.json({ error: "invalid_transfer" }, 400);
  const { toAgentId, revision } = body.data;
  const result = await db.transaction(async (tx) => {
    const [recipient] = await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, toAgentId)).for("key share");
    if (!recipient) return { error: "agent_not_found" } as const;
    const [item] = await tx.update(verseInventory)
      .set({ agentId: toAgentId, revision: sql`${verseInventory.revision} + 1` })
      .where(and(eq(verseInventory.id, id.data), eq(verseInventory.agentId, agentId), eq(verseInventory.revision, revision)))
      .returning();
    return item ? { item } : { error: "item_not_owned_or_stale" } as const;
  });
  if ("item" in result) return c.json(result);
  return c.json(result, result.error === "agent_not_found" ? 404 : 409);
});

verseEconomyRoute.get("/verse/sales", agentAuth, async (c) => {
  if (!salesEnabled()) return c.json({ error: "sales_disabled" }, 404);
  const after = uuid.optional().safeParse(c.req.query("after"));
  if (!after.success) return c.json({ error: "invalid_cursor" }, 400);
  const offers = await db.select({
    id: verseSaleOffers.id, itemName: verseSaleOffers.itemName, price: verseSaleOffers.price,
  }).from(verseSaleOffers).innerJoin(verseInventory, and(
    eq(verseInventory.id, verseSaleOffers.itemId),
    eq(verseInventory.agentId, verseSaleOffers.sellerId),
    eq(verseInventory.revision, verseSaleOffers.itemRevision),
  )).where(and(isNull(verseSaleOffers.purchasedAt), after.data ? gt(verseSaleOffers.id, after.data) : undefined))
    .orderBy(asc(verseSaleOffers.id)).limit(100);
  return c.json({ offers });
});

verseEconomyRoute.post("/verse/sales", agentAuth, async (c) => {
  if (!salesEnabled()) return c.json({ error: "sales_disabled" }, 404);
  const body = saleOffer.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_offer" }, 400);
  const { itemId, revision, price } = body.data;
  const sellerId = c.get("agentId");
  const offer = await db.transaction(async (tx) => {
    const [item] = await tx.select().from(verseInventory).where(and(
      eq(verseInventory.id, itemId), eq(verseInventory.agentId, sellerId), eq(verseInventory.revision, revision),
    )).for("no key update");
    if (!item) return null;
    const [open] = await tx.select().from(verseSaleOffers).where(and(
      eq(verseSaleOffers.itemId, itemId), eq(verseSaleOffers.itemRevision, revision), isNull(verseSaleOffers.purchasedAt),
    ));
    if (open) return open.price === price ? open : null;
    const [created] = await tx.insert(verseSaleOffers)
      .values({ itemId, itemName: item.name, itemRevision: revision, sellerId, price }).returning();
    return created;
  });
  return offer ? c.json({ offer }, 200) : c.json({ error: "stale_item_or_open_offer" }, 409);
});

verseEconomyRoute.post("/verse/sales/:id/buy", agentAuth, async (c) => {
  if (!salesEnabled()) return c.json({ error: "sales_disabled" }, 404);
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_offer" }, 400);
  // The transaction itself lives in world/agentSales.ts (Phase 4) so the
  // agent MCP surface shares this exact implementation.
  const result = await buySaleOffer(c.get("agentId"), id.data);
  if (result.ok) return c.json({ receipt: result.receipt });
  return c.json({ error: result.error }, result.status);
});

verseEconomyRoute.get("/verse/bounties", agentAuth, async (c) => {
  const bounties = await db.select().from(verseBounties)
    .where(gt(verseBounties.closesAt, sql`clock_timestamp()`))
    .orderBy(asc(verseBounties.closesAt)).limit(100);
  return c.json({ bounties });
});

verseEconomyRoute.get("/verse/bounties/:id", agentAuth, async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_bounty" }, 400);
  const [bounty] = await db.select().from(verseBounties).where(eq(verseBounties.id, id.data));
  return bounty ? c.json({ bounty }) : c.json({ error: "bounty_not_found" }, 404);
});

verseEconomyRoute.post("/admin/verse/bounties", adminAuth, async (c) => {
  const body = createBounty.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_bounty" }, 400);
  const { title, rewardName, windowSeconds } = body.data;
  const [bounty] = await db.insert(verseBounties)
    .values({ title, rewardName, closesAt: sql`clock_timestamp() + ${windowSeconds} * interval '1 second'` })
    .returning();
  return c.json({ bounty }, 201);
});

verseEconomyRoute.post("/verse/bounties/:id/claim", agentAuth, async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_bounty" }, 400);
  const agentId = c.get("agentId");
  const result = await db.transaction(async (tx) => {
    const [bounty] = await tx.select().from(verseBounties).where(eq(verseBounties.id, id.data)).for("update");
    if (!bounty) return "bounty_not_found";
    const [existing] = await tx.select().from(verseBountyClaims)
      .where(and(eq(verseBountyClaims.bountyId, id.data), eq(verseBountyClaims.agentId, agentId)));
    if (existing) return "entered";
    const [visit] = await tx.select({ id: agentVisits.id }).from(agentVisits)
      .where(and(eq(agentVisits.agentId, agentId), isNull(agentVisits.endedAt),
        gt(agentVisits.endsAt, sql`clock_timestamp()`), lt(agentVisits.actionsUsed, agentVisits.maxActions)))
      .for("share");
    if (!visit) return "active_visit_required";
    // Check the database clock after taking the locks so waiting for a lock
    // cannot admit a claim after the window.
    const [open] = await tx.select({ id: verseBounties.id }).from(verseBounties)
      .where(and(eq(verseBounties.id, id.data), isNull(verseBounties.settledAt), gt(verseBounties.closesAt, sql`clock_timestamp()`)));
    if (!open) return "bounty_closed";
    await tx.insert(verseBountyClaims).values({ bountyId: id.data, agentId });
    return "entered";
  });
  if (result === "entered") return c.json({ status: result });
  return c.json({ error: result }, result === "bounty_not_found" ? 404 : result === "active_visit_required" ? 403 : 410);
});

verseEconomyRoute.post("/admin/verse/bounties/:id/settle", adminAuth, async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_bounty" }, 400);
  const result = await db.transaction(async (tx) => {
    const [bounty] = await tx.select().from(verseBounties).where(eq(verseBounties.id, id.data)).for("update");
    if (!bounty) return { error: "bounty_not_found" } as const;
    if (bounty.settledAt) return { bounty };
    const [open] = await tx.select({ id: verseBounties.id }).from(verseBounties)
      .where(and(eq(verseBounties.id, id.data), gt(verseBounties.closesAt, sql`clock_timestamp()`)));
    if (open) return { error: "bounty_open" } as const;
    const entrants = await tx.select({ agentId: verseBountyClaims.agentId }).from(verseBountyClaims)
      .innerJoin(agents, eq(agents.id, verseBountyClaims.agentId))
      .where(eq(verseBountyClaims.bountyId, id.data)).for("key share", { of: agents });
    const winner = entrants.length ? entrants[randomInt(entrants.length)] : undefined;
    const [reward] = winner
      ? await tx.insert(verseInventory).values({ agentId: winner.agentId, name: bounty.rewardName }).returning()
      : [];
    const [settled] = await tx.update(verseBounties).set({
      settledAt: sql`clock_timestamp()`, winnerAgentId: winner?.agentId ?? null, rewardItemId: reward?.id ?? null,
    }).where(eq(verseBounties.id, id.data)).returning();
    return { bounty: settled };
  });
  if ("bounty" in result) return c.json(result);
  return c.json(result, result.error === "bounty_not_found" ? 404 : 409);
});
