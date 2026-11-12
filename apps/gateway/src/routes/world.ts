import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { agents, agentVisits, agentWallets } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { agentAuth, agentAuthUncounted } from "../middleware/agentAuth";
import { checkAgentSendRate, checkAutonomy } from "../policy/gate";
import { consumeVisitAction, refundVisitAction } from "../policy/visits";
import { audit } from "../util/audit";
import { log, logError } from "../util/log";
import { onAgentGone, onVisitExtended } from "../world/hooks";
import { agentBodies, BODIES } from "@aiverse/world-sim/bodies";
import type { SimClient } from "../world/simClient";
import type { LookClient } from "../world/lookClient";
import { angleDiffDeg, createSeeQueue, seeView, type SeeQueueOptions } from "../world/seeJobs";

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
/** Pace for POST /world/see: captures serialize on the look service's single page and take minutes there, so a second
 * see inside the window is refused (429), never queued behind the first. */
const SEE_MIN_INTERVAL_MS = 5_000;

type Env = { Variables: { agentId: string; visitEndsAt: number; visitId: string } };

/** Render queue defaults for POST /world/see: one capture at a time (the service has one page), a short queue, and a hard cap on how
 * stale a queued request may get before it is dropped instead of rendered. Env-tunable for a GPU host with more capacity. */
function seeOptionsFromEnv(): SeeQueueOptions {
  const n = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return { concurrency: n("LOOK_CONCURRENCY", 1), maxQueue: n("SEE_MAX_QUEUE", 20), maxQueueWaitMs: n("SEE_MAX_QUEUE_WAIT_MS", 30_000), keepMs: 10 * 60_000, maxKept: 500 };
}

export function createWorldRoute(sim: SimClient, look?: LookClient | null, seeOpts?: Partial<SeeQueueOptions>) {
  const route = new Hono<Env>();
  const lastSeeAt = new Map<string, number>();
  const seeQueue = look ? createSeeQueue(look, { ...seeOptionsFromEnv(), ...seeOpts }) : null;

  // Any path that removes an agent (visit end, pause, kill, key rotation, delete) removes its body.
  onAgentGone((agentId, reason) => {
    seeQueue?.cancelAgent(agentId); // a photo still waiting for its turn is dropped with the body
    return sim.call("DELETE", `/bodies/${agentId}`).then(
      (r) => { if (r.ok) log("world_body_removed", { agentId, reason }); },
      (e) => logError("world_body_remove_failed", e, { agentId, reason }),
    );
  });

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
    c.set("visitId", visit.id);
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
    // Optional figure pick: {"body": "<id>"} (loadtest 2026-11-11: picks
    // sent by 45 of 50 agents were silently swallowed and every agent wore
    // remy). Validated HERE, loudly, so a bad pick is a 400 naming the
    // problem and the pickable set — the field is never ignored. The sim
    // re-validates on its side of the wire.
    const raw = (await c.req.json().catch(() => null)) as { body?: unknown } | null;
    const pick = raw?.body;
    if (pick !== undefined && typeof pick !== "string") {
      return c.json({ error: "body_not_pickable", message: "body must be a string body id" }, 400);
    }
    if (typeof pick === "string") {
      const pickable = agentBodies().map((b) => b.id);
      if (!pickable.includes(pick)) {
        const known = BODIES[pick];
        return c.json({
          error: "body_not_pickable",
          message: known
            ? `body "${pick}" is cast-only and cannot be worn by an agent`
            : `unknown body "${pick}"`,
          pickable,
        }, 400);
      }
    }
    return forward(c, agentId, "POST", "/bodies", JSON.stringify({ agentId, expiresAtMs: c.get("visitEndsAt"), ...(pick ? { body: pick } : {}) }));
  });
  // Free read: the body's own state, or 404 no_body ("attach one first"). Cold agents probed GET /body and read the old bare 404 as
  // "this API has no bodies" (cold-agent runs 2026-11-10/11).
  route.get("/body", (c) => forward(c, c.get("agentId"), "GET", `/bodies/${c.get("agentId")}`));
  route.delete("/body", (c) => forward(c, c.get("agentId"), "DELETE", `/bodies/${c.get("agentId")}`));
  // ?heardSince=<seq> returns only speech newer than that cursor (the last observe.heard[].seq you saw).
  route.get("/observe", (c) => forward(c, c.get("agentId"), "GET", `/bodies/${c.get("agentId")}/observe?heardSince=${Math.max(0, Number(c.req.query("heardSince")) || 0)}`));
  // One glance: depth + class images and the scene. A POST, so agentAuth counts it against the visit's action cap (it is a costly
  // sense); the sim allows 1 per second per body.
  route.post("/look", (c) => forward(c, c.get("agentId"), "POST", `/bodies/${c.get("agentId")}/look`, "{}"));
  // One photograph: the photorealistic head-cam (the look service's warm Chromium page), as opposed to /look's synthetic
  // depth+class glance. ASYNC: a capture takes tens of seconds to minutes, so this queues a job and answers 202 at once with
  // {see:{id, state, requestedAt, pose}}; GET /world/see/:id[?waitMs=] reads it. The photo shows the world as of the REQUEST, so
  // the finished job carries `ageMs` and `moved` (how far the body has walked and turned since) for the agent to judge freshness
  // against its live observe/look. The request costs one action (counted by agentAuth); a job that ends without a photo is refunded.
  // The pose comes from the sim, never from the request: an agent can only photograph from where its body stands, facing where it
  // faces (turn with `face` first). Fail closed: no client configured, service down or wedged is look_unavailable; never a fake frame.
  route.post("/see", async (c) => {
    const agentId = c.get("agentId");
    if (!look || !seeQueue) return c.json({ error: "look_unavailable" }, 502);
    const nowMs = Date.now();
    if (nowMs - (lastSeeAt.get(agentId) ?? 0) < SEE_MIN_INTERVAL_MS) {
      const mine = seeQueue.activeFor(agentId); // inside the window with a photo still pending: name it, so the agent polls that one
      return c.json(mine ? { error: "see_in_flight", seeId: mine.id, state: mine.state } : { error: "rate_limited" }, 429, { "retry-after": String(Math.ceil(SEE_MIN_INTERVAL_MS / 1000)) });
    }
    const poseRes = await forward(c, agentId, "GET", `/bodies/${agentId}`);
    if (poseRes.status !== 200) return poseRes;
    const pose = ((await poseRes.json().catch(() => null)) as { body?: { x?: unknown; z?: unknown; heading?: unknown; gaze?: { yawDeg?: unknown; pitchDeg?: unknown } } } | null)?.body;
    if (!pose || typeof pose.x !== "number" || typeof pose.z !== "number" || typeof pose.heading !== "number") {
      logError("world_see_bad_pose", new Error("sim body read carried no pose"), { agentId });
      return c.json({ error: "look_unavailable" }, 502);
    }
    // Sim headings are radians (walker convention); the look service faces degrees of the same convention.
    const toDeg = (rad: number) => Math.round(((((rad * 180) / Math.PI) % 360) + 360) % 360 * 10) / 10;
    const g = pose.gaze;
    const gaze = g && typeof g.yawDeg === "number" && typeof g.pitchDeg === "number" ? { yawDeg: g.yawDeg, pitchDeg: g.pitchDeg } : undefined;
    const requested = { x: pose.x, z: pose.z, headingDeg: toDeg(pose.heading), ...(gaze ? { gaze } : {}) };
    const visitId = c.get("visitId");
    // Stamp BEFORE submitting: a capture that fails at once refunds (and un-stamps) from inside submit, which must not be overwritten after.
    const prevStamp = lastSeeAt.get(agentId);
    lastSeeAt.set(agentId, nowMs);
    const res = seeQueue.submit(agentId, requested, {
      // How far the body has walked / turned since the request: the agent's freshness signal for a photo that took a while.
      moved: async (job) => {
        const r = await sim.call("GET", `/bodies/${agentId}`).catch(() => null);
        const b = r && r.ok ? ((await r.json().catch(() => null)) as { body?: { x?: unknown; z?: unknown; heading?: unknown } } | null)?.body : null;
        if (!b || typeof b.x !== "number" || typeof b.z !== "number" || typeof b.heading !== "number") return undefined;
        return { distanceM: Math.round(Math.hypot(b.x - job.pose.x, b.z - job.pose.z) * 100) / 100, turnedDeg: Math.round(angleDiffDeg(toDeg(b.heading), job.pose.headingDeg) * 10) / 10 };
      },
      // Failed / dropped job: the request is not charged (the request already counted, since it answered 202).
      refund: async (job) => { lastSeeAt.delete(agentId); log("world_see_failed", { agentId, error: job.error }); await refundVisitAction(visitId); },
    });
    if (!res.ok) {
      if (prevStamp === undefined) lastSeeAt.delete(agentId); else lastSeeAt.set(agentId, prevStamp);
      if (res.reason === "in_flight") return c.json({ error: "see_in_flight", seeId: res.job.id, state: res.job.state }, 429, { "retry-after": String(Math.ceil(SEE_MIN_INTERVAL_MS / 1000)) });
      return c.json({ error: "look_busy" }, 503, { "retry-after": "10" });
    }
    return c.json({ see: seeView(res.job, Date.now()) }, 202);
  });

  // The photo's status. A free GET; ?waitMs=<=10000 holds the call until the job leaves queued/running (or the wait ends), the same
  // long-poll as /act/:id. Only your own jobs: another agent's id is unknown_see, like a stale one (jobs are kept 10 minutes).
  route.get("/see/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id) || !seeQueue) return c.json({ error: "unknown_see" }, 404);
    const job = seeQueue.get(c.get("agentId"), id);
    if (!job) return c.json({ error: "unknown_see" }, 404);
    await seeQueue.wait(job, Math.min(MAX_WAIT_MS, Math.max(0, Number(c.req.query("waitMs")) || 0)));
    return c.json({ see: seeView(job, Date.now()) });
  });
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
    const agentId = c.get("agentId");
    // Speech is the one action with a social cost: it runs the same autonomy and send-rate gates as a conversation message, and the
    // sim gets the speaker's display name from here (the agent cannot choose it).
    let name: string | undefined;
    const isSay = typeof b.action === "object" && b.action !== null && (b.action as { type?: unknown }).type === "say";
    if (isSay) {
      const [agent, wallet] = await Promise.all([
        db.query.agents.findFirst({ where: eq(agents.id, agentId) }),
        db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agentId) }),
      ]);
      if (!agent || !wallet) return c.json({ error: "agent wallet not found" }, 500);
      const autonomy = checkAutonomy(wallet.autonomyMode, 0);
      if (!autonomy.allowed) return c.json({ error: autonomy.reason }, 403);
      const rate = await checkAgentSendRate(agentId);
      if (!rate.allowed) return c.json({ error: rate.reason }, 429, { "retry-after": "1" });
      name = agent.name;
    }
    // Only the named fields cross; anything else the agent sent stays here.
    const r = await forward(c, agentId, "POST", `/bodies/${agentId}/act`, JSON.stringify({ id: b.id, action: b.action, name }));
    if (r.status === 202) {
      await consumeVisitAction(agentId);
      // One audit row per spoken line, so the report button and the owner can see what an agent said in the world.
      if (isSay) await audit({ event: "world.say", agentId, actorType: "agent", actorId: agentId, metadata: { text: String((b.action as { text?: unknown }).text).slice(0, 140) } });
    }
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
