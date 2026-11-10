import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { agentVisits } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { agentAuth } from "../middleware/agentAuth";
import { log, logError } from "../util/log";
import { onAgentGone } from "../world/hooks";
import type { SimClient } from "../world/simClient";

// World: a body for an agent in the City 3 sim (apps/sim), reached only through here.
//
// The gateway is the single enforcement point: agentAuth (token, pause, claim, visit deadline + action cap, presence) runs first, then
// this route requires an ACTIVE visit — a body is a platform cost, so the owner's envelope (deadline, action cap) must exist. The sim
// never sees an agent token; it gets the agent id and the visit's deadline (a hard expiry on its side as a second line).
// Non-GET calls (attach, detach, act) count against the visit's action cap through agentAuth; polling (observe, act status) is GET.
const ID_RE = /^[a-zA-Z0-9-]{1,80}$/;
const MAX_BODY = 4096;

type Env = { Variables: { agentId: string; visitEndsAt: number } };

export function createWorldRoute(sim: SimClient) {
  const route = new Hono<Env>();

  // Any path that removes an agent (visit end, pause, kill, key rotation, delete) removes its body.
  onAgentGone((agentId, reason) =>
    sim.call("DELETE", `/bodies/${agentId}`).then(
      (r) => { if (r.ok) log("world_body_removed", { agentId, reason }); },
      (e) => logError("world_body_remove_failed", e, { agentId, reason }),
    ),
  );

  route.use("*", agentAuth);
  route.use("*", async (c, next) => {
    const visit = await db.query.agentVisits.findFirst({
      where: and(eq(agentVisits.agentId, c.get("agentId")), isNull(agentVisits.endedAt)),
    });
    if (!visit) return c.json({ error: "no_visit", hint: "the owner must start a visit (POST /owners/agents/:id/visits) before an agent can have a body" }, 403);
    c.set("visitEndsAt", visit.endsAt.getTime());
    await next();
  });

  async function forward(c: { json: (b: unknown, s?: number) => Response }, agentId: string, method: string, path: string, body?: string) {
    let r: Response;
    try {
      r = await sim.call(method, path, body);
    } catch (e) {
      logError("world_sim_unreachable", e, { agentId, path });
      return c.json({ error: "world_unavailable" }, 503);
    }
    if (r.status === 401 || r.status === 426) {
      logError("world_sim_misconfigured", new Error(`sim answered ${r.status}`), { agentId });
      return c.json({ error: "world_unavailable" }, 502);
    }
    const data = await r.json().catch(() => ({ error: "bad_sim_response" }));
    const retry = r.headers.get("retry-after");
    return new Response(JSON.stringify(data), { status: r.status, headers: { "content-type": "application/json", ...(retry ? { "retry-after": retry } : {}) } });
  }

  route.post("/body", async (c) => {
    const agentId = c.get("agentId");
    return forward(c, agentId, "POST", "/bodies", JSON.stringify({ agentId, expiresAtMs: c.get("visitEndsAt") }));
  });
  route.delete("/body", (c) => forward(c, c.get("agentId"), "DELETE", `/bodies/${c.get("agentId")}`));
  route.get("/observe", (c) => forward(c, c.get("agentId"), "GET", `/bodies/${c.get("agentId")}/observe`));
  route.get("/places", (c) => forward(c, c.get("agentId"), "GET", "/places"));

  route.post("/act", async (c) => {
    const text = await c.req.text();
    if (text.length > MAX_BODY) return c.json({ error: "too_large" }, 413);
    let b: { id?: unknown; action?: unknown };
    try { b = JSON.parse(text); } catch { return c.json({ error: "bad_json" }, 400); }
    if (typeof b?.id !== "string" || !ID_RE.test(b.id)) return c.json({ error: "invalid_action", message: "id must be 1-80 letters, digits or dashes" }, 400);
    // Only the two fields cross; anything else the agent sent stays here.
    return forward(c, c.get("agentId"), "POST", `/bodies/${c.get("agentId")}/act`, JSON.stringify({ id: b.id, action: b.action }));
  });

  route.get("/act/:id", (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "invalid_action" }, 400);
    return forward(c, c.get("agentId"), "GET", `/bodies/${c.get("agentId")}/act/${id}`);
  });

  return route;
}
