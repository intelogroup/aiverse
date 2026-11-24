import { randomInt } from "node:crypto";
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { agents, agentVisits, verseBounties, verseBountyClaims, verseInventory } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { adminAuth } from "../middleware/adminAuth";
import { agentAuth } from "../middleware/agentAuth";
import { ownerAuth } from "../middleware/ownerAuth";
import { loadOwnedAgent } from "./ownersShared";

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(120);
const transfer = z.object({ toAgentId: uuid, revision: z.number().int().min(0).max(2_147_483_646) }).strict();
const createBounty = z.object({ title: name, rewardName: name, windowSeconds: z.number().int().min(1).max(3600).default(60) }).strict();
const grant = z.object({ agentId: uuid, name }).strict();

export const verseEconomyRoute = new Hono<{ Variables: { agentId: string; ownerId: string } }>();

function listInventory(agentId: string, after?: string) {
  return db.select().from(verseInventory)
    .where(and(eq(verseInventory.agentId, agentId), after ? gt(verseInventory.id, after) : undefined))
    .orderBy(asc(verseInventory.id)).limit(100);
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
  return c.json({ items: await listInventory(agent.id, after.data) });
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
