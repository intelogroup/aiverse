import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { agentVisits } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { agentAuth, agentAuthUncounted } from "../middleware/agentAuth";
import { consumeVisitAction } from "../policy/visits";
import { log, logError } from "../util/log";
import { onAgentGone, onVisitExtended } from "../world/hooks";
import type { SimClient } from "../world/simClient";

// World: a body for an agent in the City 3 sim (apps/sim), reached only through here.
//
// The gateway is the single enforcement point: agentAuth (token, pause, claim, visit deadline + action cap, presence) runs first, then
// this route requires an ACTIVE visit — a body is a platform cost, so the owner's envelope (deadline, action cap) must exist. The sim
// never sees an agent token; it gets the agent id and the visit's deadline (a hard expiry on its side as a second line).
// Non-GET calls (attach, detach, act) count against the visit's action cap through agentAuth; polling (observe, act status) is GET.
const ID_RE = /^[a-zA-Z0-9-]{1,80}$/;
const MAX_BODY = 4096;
const MAX_WAIT_MS = 10_000;
const POLL_MS = 400;

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

  // A visit extension moves the deadline the body's sim-side expiry was
  // stamped from: re-stamp it (a re-attach at the new deadline — the sim
  // refreshes the expiry and keeps the body where it stands). No body,
  // nothing to re-stamp: the GET answers 404 and this is a no-op.
  onVisitExtended((agentId, endsAtMs) =>
    sim.call("GET", `/bodies/${agentId}`).then(
      (cur) => {
        if (!cur.ok) return;
        return sim.call("POST", "/bodies", JSON.stringify({ agentId, expiresAtMs: endsAtMs })).then((r) => {
          if (r.ok) log("world_body_expiry_restamped", { agentId, endsAtMs });
        });
      },
      (e) => logError("world_body_restamp_failed", e, { agentId }),
    ),
  );

  // POST /act counts in its handler, only for a NEW accepted act (sim 202): retries, 429s and refused actions do not spend the visit.
  route.use("*", (c, next) =>
    (c.req.method === "POST" && c.req.path.endsWith("/act") ? agentAuthUncounted : agentAuth)(c as unknown as Parameters<typeof agentAuth>[0], next));
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
  // Free read: the body's own state, or 404 no_body ("attach one first"). Cold agents probed GET /body and read the old bare 404 as
  // "this API has no bodies" (cold-agent runs 2026-11-10/11).
  route.get("/body", (c) => forward(c, c.get("agentId"), "GET", `/bodies/${c.get("agentId")}`));
  route.delete("/body", (c) => forward(c, c.get("agentId"), "DELETE", `/bodies/${c.get("agentId")}`));
  route.get("/observe", (c) => forward(c, c.get("agentId"), "GET", `/bodies/${c.get("agentId")}/observe`));
  route.get("/places", (c) => forward(c, c.get("agentId"), "GET", "/places"));
  // The M4 docs promise GET /world/map (places): the same sim places list under the documented name.
  route.get("/map", (c) => forward(c, c.get("agentId"), "GET", "/places"));
  // The exact names `play` accepts (cold agents guessed "wave"; the clip is "Waving").
  route.get("/clips", (c) => forward(c, c.get("agentId"), "GET", "/clips"));

  route.post("/act", async (c) => {
    const text = await c.req.text();
    if (text.length > MAX_BODY) return c.json({ error: "too_large" }, 413);
    let b: { id?: unknown; action?: unknown };
    try { b = JSON.parse(text); } catch { return c.json({ error: "bad_json" }, 400); }
    if (typeof b?.id !== "string" || !ID_RE.test(b.id)) return c.json({ error: "invalid_action", message: "id must be 1-80 letters, digits or dashes" }, 400);
    // Only the two fields cross; anything else the agent sent stays here.
    const r = await forward(c, c.get("agentId"), "POST", `/bodies/${c.get("agentId")}/act`, JSON.stringify({ id: b.id, action: b.action }));
    if (r.status === 202) await consumeVisitAction(c.get("agentId"));
    return r;
  });

  // ?waitMs=<=10000 holds the call until the act settles (or the wait ends), so an agent needs one call per act instead of a polling
  // loop (about two thirds of cold agents' calls were polls). Still a free GET; it re-reads the sim every POLL_MS within its read bucket.
  route.get("/act/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "invalid_action" }, 400);
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number(c.req.query("waitMs")) || 0));
    const deadline = Date.now() + waitMs;
    for (;;) {
      const r = await forward(c, c.get("agentId"), "GET", `/bodies/${c.get("agentId")}/act/${id}`);
      if ((r.status !== 200 && r.status !== 429) || Date.now() >= deadline) return r;
      if (r.status === 200 && ((await r.clone().json()) as { act?: { state?: string } }).act?.state !== "running") return r;
      await Bun.sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
  });

  return route;
}
