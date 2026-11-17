import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { agents, agentVisits } from "@aiverse/shared/schema";
import { ownerSessionOrReadKey } from "../middleware/ownerReadAuth";
import { stopVisitRecord, extendVisitRecord, MIN_VISIT_MINUTES, MAX_VISIT_MINUTES, MIN_VISIT_ACTIONS, MAX_VISIT_ACTIONS } from "../policy/visits";
import { notifyVisitExtended } from "../world/hooks";
import { ownerAuth } from "../middleware/ownerAuth";
import { announceVisitEnded } from "../ws/gateway";
import { audit } from "../util/audit";
import { loadOwnedAgent } from "./ownersShared";

export const ownersVisitsRoute = new Hono<{ Variables: { ownerId: string } }>();

// Visits: "send this agent into the Verse for N minutes, at most M actions."
// Owner-only to start or stop — an agent cannot extend its own deadline,
// raise its own cap, or end its own visit. Enforcement (the deadline/cap
// check, the action counter) lives in middleware/agentAuth.ts and
// ws/gateway.ts's WS connect handler, both via policy/visits.ts; this route
// only creates/lists/ends the row.
ownersVisitsRoute.post("/agents/:id/visits", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const active = await db.query.agentVisits.findFirst({
    where: and(eq(agentVisits.agentId, agentId), isNull(agentVisits.endedAt)),
  });
  if (active) return c.json({ error: "agent already has an active visit — stop it first" }, 409);

  const body = await c.req.json<{ minutes?: number; maxActions?: number }>().catch(() => ({}) as { minutes?: number; maxActions?: number });
  const minutes = Number(body.minutes);
  const maxActions = Number(body.maxActions);
  if (!Number.isInteger(minutes) || minutes < MIN_VISIT_MINUTES || minutes > MAX_VISIT_MINUTES) {
    return c.json({ error: `minutes must be an integer between ${MIN_VISIT_MINUTES} and ${MAX_VISIT_MINUTES}` }, 400);
  }
  if (!Number.isInteger(maxActions) || maxActions < MIN_VISIT_ACTIONS || maxActions > MAX_VISIT_ACTIONS) {
    return c.json({ error: `maxActions must be an integer between ${MIN_VISIT_ACTIONS} and ${MAX_VISIT_ACTIONS}` }, 400);
  }

  // The active-visit check above and this insert race under concurrent
  // starts (a burst of starts all pass the check before any insert
  // lands). The partial unique index on active visits (migration 0043)
  // is the authority: the loser's insert fails 23505 and maps to the
  // same 409 the sequential check returns. The PG code lives on cause,
  // not the drizzle wrapper's message — same trap as rotate-key above.
  let visit: typeof agentVisits.$inferSelect;
  try {
    const [inserted] = await db
      .insert(agentVisits)
      .values({ agentId, ownerId, endsAt: new Date(Date.now() + minutes * 60_000), maxActions })
      .returning();
    visit = inserted;
  } catch (err: any) {
    const pgCode = err?.code ?? err?.cause?.code;
    const detail = String(err?.cause?.message ?? err?.message ?? err);
    if (pgCode === "23505" || detail.includes("agent_visits_one_active")) {
      return c.json({ error: "agent already has an active visit — stop it first" }, 409);
    }
    throw err;
  }

  await audit({ event: "visit.started", agentId, ownerId, actorType: "owner", actorId: ownerId, metadata: { minutes, maxActions } });
  return c.json({ visit }, 201);
});

ownersVisitsRoute.get("/agents/:id/visits", ownerSessionOrReadKey, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent || agent.ownerId !== ownerId) return c.json({ error: "not found" }, 404);

  const visits = await db.query.agentVisits.findMany({
    where: eq(agentVisits.agentId, agentId),
    orderBy: desc(agentVisits.startedAt),
    limit: 50,
  });
  return c.json({ visits });
});

ownersVisitsRoute.post("/agents/:id/visits/:visitId/stop", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const visit = await db.query.agentVisits.findFirst({
    where: and(eq(agentVisits.id, c.req.param("visitId")), eq(agentVisits.agentId, agentId)),
  });
  if (!visit) return c.json({ error: "not found" }, 404);

  const ended = await stopVisitRecord(visit.id);
  if (!ended) return c.json({ error: "visit already ended" }, 409);
  await announceVisitEnded(ended);
  await audit({ event: "visit.stopped", agentId, ownerId, actorType: "owner", actorId: ownerId, metadata: { visitId: visit.id } });

  return c.json({ ok: true });
});

// Extend an ACTIVE visit in place (2026-11-11): the deadline moves out by
// `minutes` and nothing else changes — the visit row, the actions used,
// and (via notifyVisitExtended -> the world route's re-stamp) any live
// body's expiry all carry on. This replaces the stop -> start ->
// re-attach dance the 50-agent loadtest had to perform mid-run. Owner-
// only, like start/stop: an agent cannot extend its own envelope.
ownersVisitsRoute.post("/agents/:id/visits/:visitId/extend", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const visit = await db.query.agentVisits.findFirst({
    where: and(eq(agentVisits.id, c.req.param("visitId")), eq(agentVisits.agentId, agentId)),
  });
  if (!visit) return c.json({ error: "not found" }, 404);
  if (visit.endedAt) return c.json({ error: "visit already ended" }, 409);

  const body = await c.req.json<{ minutes?: number }>().catch(() => ({}) as { minutes?: number });
  const minutes = Number(body.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_VISIT_MINUTES) {
    return c.json({ error: `minutes must be an integer between 1 and ${MAX_VISIT_MINUTES}` }, 400);
  }
  // The extension may not push the deadline past the same one-week
  // horizon a fresh visit is bounded by (measured from now).
  if (visit.endsAt.getTime() + minutes * 60_000 > Date.now() + MAX_VISIT_MINUTES * 60_000) {
    return c.json({ error: "extension would push the visit past the one-week maximum" }, 400);
  }

  const extended = await extendVisitRecord(visit, minutes);
  if (!extended) return c.json({ error: "visit already ended" }, 409);
  await audit({ event: "visit.extended", agentId, ownerId, actorType: "owner", actorId: ownerId, metadata: { visitId: visit.id, minutes, endsAt: extended.endsAt } });
  notifyVisitExtended(agentId, extended.endsAt.getTime());

  return c.json({ visit: extended });
});
