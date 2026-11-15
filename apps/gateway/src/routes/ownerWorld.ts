import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { agents, agentVisits } from "@aiverse/shared/schema";
import { isAgentBody } from "@aiverse/world-sim/bodies";
import { db } from "../db/client";
import { ownerAuth } from "../middleware/ownerAuth";
import { takeToken } from "../policy/memoryStore";
import { extendVisitRecord, startVisitIfNoneActive, stopVisitRecord } from "../policy/visits";
import { audit } from "../util/audit";
import { log, logError } from "../util/log";
import { announceVisitEnded } from "../ws/gateway";
import { notifyVisitExtended } from "../world/hooks";
import type { SimClient } from "../world/simClient";

// Owner presence: a signed-in owner's agent stands in the world (so the console can land on it in follow view).
//
// It reuses the visit envelope, never bypasses it: a body only exists inside an active visit. A presence visit is SHORT
// (PRESENCE_MINUTES) and the open console page keeps it alive with POST every ~30 s; when the page goes away the visit simply runs
// out (the existing sweep ends it and removes the body), and logout ends it at once. A visit the owner or the agent started with a
// longer deadline is never extended or ended by this route: only short ones (remaining <= PRESENCE_MINUTES) count as presence.
export const PRESENCE_MINUTES = 3;
export const PRESENCE_ACTIONS = 200;
const PRESENCE_MS = PRESENCE_MINUTES * 60_000;
/** The heartbeat tops a visit up only when under half a window remains, so its remaining time stays within (0, 1.5 windows]; anything up
 * to two windows long is therefore ours (a longer visit was set by an owner or an agent and is never touched). */
const RENEW_BELOW_MS = PRESENCE_MS / 2;
const SHORT_VISIT_MS = PRESENCE_MS * 2;
const NOT_ELIGIBLE = new Set(["paused", "unclaimed", "killed"]);

export function createOwnerWorldRoute(sim: SimClient) {
  const route = new Hono<{ Variables: { ownerId: string } }>();
  route.use("*", ownerAuth);
  route.use("*", async (c, next) => {
    // ~1 call / 15 s sustained, a short burst allowed (page load + reconnects).
    if (!(await takeToken(`owner-presence:${c.get("ownerId")}`, 10, 1 / 15))) return c.json({ error: "rate_limited" }, 429);
    await next();
  });

  /** The owner's agent to stand in the world: one that already has an active visit, else the most recently seen eligible one. */
  async function pickAgent(ownerId: string) {
    const rows = await db.query.agents.findMany({
      where: eq(agents.ownerId, ownerId),
      columns: { id: true, name: true, status: true, body: true, lastSeenAt: true },
      orderBy: desc(agents.lastSeenAt),
    });
    const eligible = rows.filter((a) => !NOT_ELIGIBLE.has(a.status));
    if (eligible.length === 0) return null;
    for (const a of eligible) {
      const v = await db.query.agentVisits.findFirst({ where: and(eq(agentVisits.agentId, a.id), isNull(agentVisits.endedAt)) });
      if (v) return { agent: a, visit: v };
    }
    return { agent: eligible[0], visit: null };
  }

  // Ensure: idempotent, safe to call as a heartbeat. 200 {agentId, name, attached, visitEndsAt}; 204-like {agent:null} when the owner
  // has no eligible agent (nothing to stand in the world).
  route.post("/", async (c) => {
    const ownerId = c.get("ownerId");
    const picked = await pickAgent(ownerId);
    if (!picked) return c.json({ agent: null });
    const { agent } = picked;
    let visit = picked.visit;
    if (!visit) {
      const started = await startVisitIfNoneActive(agent.id, ownerId, PRESENCE_MINUTES, PRESENCE_ACTIONS);
      visit = started.visit;
      if (started.created) await audit({ event: "visit.started", agentId: agent.id, ownerId, actorType: "owner", actorId: ownerId, metadata: { minutes: PRESENCE_MINUTES, maxActions: PRESENCE_ACTIONS, presence: true } });
    } else if (visit.endsAt.getTime() - Date.now() <= RENEW_BELOW_MS) {
      const extended = await extendVisitRecord(visit, PRESENCE_MINUTES);
      if (extended) { visit = extended; notifyVisitExtended(agent.id, extended.endsAt.getTime()); }
    }
    try {
      const cur = await sim.call("GET", `/bodies/${agent.id}`);
      let attached = cur.ok;
      if (!attached) {
        // The owner's saved default body, re-checked (a body retired to cast-only since falls back to the platform default).
        const r = await sim.call("POST", "/bodies", JSON.stringify({ agentId: agent.id, expiresAtMs: visit.endsAt.getTime(), ...(isAgentBody(agent.body) ? { body: agent.body } : {}) }));
        attached = r.ok;
        if (r.ok) log("world_owner_presence_attached", { agentId: agent.id });
        else logError("world_owner_presence_attach_failed", new Error(`sim answered ${r.status}`), { agentId: agent.id });
      }
      return c.json({ agent: { id: agent.id, name: agent.name }, attached, visitEndsAt: visit.endsAt.getTime() });
    } catch (e) {
      logError("world_owner_presence_sim_unreachable", e, { agentId: agent.id });
      return c.json({ agent: { id: agent.id, name: agent.name }, attached: false, visitEndsAt: visit.endsAt.getTime() });
    }
  });

  // Logout: end a presence visit (short ones only) so the body leaves now; a long visit stays as its owner set it.
  route.delete("/", async (c) => {
    const ownerId = c.get("ownerId");
    const picked = await pickAgent(ownerId);
    if (!picked?.visit || picked.visit.endsAt.getTime() - Date.now() > SHORT_VISIT_MS) return c.json({ ok: true, ended: false });
    const ended = await stopVisitRecord(picked.visit.id);
    if (ended) {
      await announceVisitEnded(ended);
      await audit({ event: "visit.stopped", agentId: picked.agent.id, ownerId, actorType: "owner", actorId: ownerId, metadata: { visitId: picked.visit.id, presence: true } });
    }
    return c.json({ ok: true, ended: !!ended });
  });

  return route;
}
