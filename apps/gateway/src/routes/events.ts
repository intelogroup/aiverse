import { Hono, type MiddlewareHandler } from "hono";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/client";
import { agents, agentEvents, eggClaims } from "@aiverse/shared/schema";
import { EGGS } from "@aiverse/shared/eggs";
import {
  CHEERS, CLIENT_EVENT_TYPES, cleanDetail, cosmeticForEgg, topMoments,
  type AgentEvent, type AgentEventType, type Passport,
} from "@aiverse/shared/events";
import { agentAuth } from "../middleware/agentAuth";
import { takeToken } from "../policy/memoryStore";
import { clientIp } from "../util/clientIp";

// Public event log + spectator surfaces (cheer, passport, digest).
// shortcut: client-reported event types are trusted for lore/clips only (like egg position); nothing of value reads them.
export const eventsRoute = new Hono<{ Variables: { agentId: string } }>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toEvent = (r: { id: string; type: string; detail: string; createdAt: Date }): AgentEvent =>
  ({ id: r.id, type: r.type as AgentEventType, detail: r.detail, at: r.createdAt.toISOString() });

eventsRoute.get("/agent/me", agentAuth, async (c) => {
  const a = await db.query.agents.findFirst({ where: eq(agents.id, c.get("agentId")), columns: { id: true, name: true } });
  return c.json({ id: a!.id, name: a!.name });
});

eventsRoute.post("/events", agentAuth, async (c) => {
  const id = c.get("agentId");
  if (!(await takeToken(`events:${id}`, 20, 1))) return c.json({ error: "rate_limited" }, 429);
  const body = await c.req.json<{ type?: unknown; detail?: unknown }>().catch(() => null);
  if (!body || !(CLIENT_EVENT_TYPES as readonly unknown[]).includes(body.type)) return c.json({ error: "bad type" }, 400);
  await db.insert(agentEvents).values({ agentId: id, type: body.type as string, detail: cleanDetail(body.detail) });
  return c.json({ ok: true }, 201);
});

// Public reads are IP-limited like /public/*.
const publicGuard: MiddlewareHandler = async (c, next) => {
  if (!(await takeToken(`public-ev:${clientIp(c)}`, 30, 5))) return c.json({ error: "rate_limited" }, 429);
  await next();
};

async function publicAgent(idParam: string) {
  if (!UUID.test(idParam)) return null;
  return (await db.query.agents.findFirst({ where: eq(agents.id, idParam), columns: { id: true, name: true, status: true } })) ?? null;
}

eventsRoute.get("/public/agents/:id/events", publicGuard, async (c) => {
  const a = await publicAgent(c.req.param("id"));
  if (!a) return c.json({ error: "not found" }, 404);
  const since = c.req.query("since");
  const sinceDate = since ? new Date(since) : null;
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 30, 1), 100);
  const rows = await db.select().from(agentEvents)
    .where(and(eq(agentEvents.agentId, a.id), eq(agentEvents.visibility, "public"), sinceDate && !isNaN(+sinceDate) ? gt(agentEvents.createdAt, sinceDate) : undefined))
    .orderBy(desc(agentEvents.createdAt)).limit(limit);
  return c.json({ name: a.name, events: rows.map(toEvent) });
});

eventsRoute.post("/public/agents/:id/cheer", publicGuard, async (c) => {
  const a = await publicAgent(c.req.param("id"));
  if (!a) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ cheer?: unknown }>().catch(() => null);
  if (!body || !(CHEERS as readonly unknown[]).includes(body.cheer)) return c.json({ error: "bad cheer" }, 400);
  // one cheer per viewer per agent every 3 s
  if (!(await takeToken(`cheer:${clientIp(c)}:${a.id}`, 1, 1 / 3))) return c.json({ error: "rate_limited" }, 429);
  await db.insert(agentEvents).values({ agentId: a.id, type: "cheered", detail: body.cheer as string });
  return c.json({ ok: true }, 201);
});

async function passportOf(a: { id: string; name: string }): Promise<Passport> {
  const [claims, counts, recent] = await Promise.all([
    db.select({ eggId: eggClaims.eggId }).from(eggClaims).where(eq(eggClaims.agentId, a.id)).orderBy(eggClaims.claimedAt),
    db.select({ type: agentEvents.type, n: sql<number>`count(*)::int` }).from(agentEvents)
      .where(and(eq(agentEvents.agentId, a.id), eq(agentEvents.visibility, "public"))).groupBy(agentEvents.type),
    db.select().from(agentEvents).where(and(eq(agentEvents.agentId, a.id), eq(agentEvents.visibility, "public")))
      .orderBy(desc(agentEvents.createdAt)).limit(200),
  ]);
  // Newest claim last, so the console wears the most recent cosmetic.
  const cosmetics = [...new Set(claims.map(c => cosmeticForEgg(c.eggId)))];
  return {
    agentId: a.id, name: a.name, eggsFound: claims.length, eggsTotal: Object.keys(EGGS).length, cosmetics,
    counts: Object.fromEntries(counts.map(c => [c.type, c.n])),
    best: topMoments(recent.map(toEvent), 1)[0] ?? null,
  };
}

eventsRoute.get("/public/agents/:id/passport", publicGuard, async (c) => {
  const a = await publicAgent(c.req.param("id"));
  if (!a) return c.json({ error: "not found" }, 404);
  return c.json(await passportOf(a));
});

// "While you were away": the best three moments since a time (default 24 h).
eventsRoute.get("/public/agents/:id/digest", publicGuard, async (c) => {
  const a = await publicAgent(c.req.param("id"));
  if (!a) return c.json({ error: "not found" }, 404);
  const since = new Date(c.req.query("since") ?? Date.now() - 86_400_000);
  const rows = await db.select().from(agentEvents)
    .where(and(eq(agentEvents.agentId, a.id), eq(agentEvents.visibility, "public"), gt(agentEvents.createdAt, isNaN(+since) ? new Date(Date.now() - 86_400_000) : since)))
    .orderBy(desc(agentEvents.createdAt)).limit(300);
  return c.json({ name: a.name, total: rows.length, moments: topMoments(rows.map(toEvent), 3) });
});
