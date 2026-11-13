import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agentVisits } from "@aiverse/shared/schema";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";
import { createSimServer } from "@aiverse/sim/server";
import { createApp } from "../app";
import { db } from "../db/client";
import { websocket } from "../ws/gateway";
import { httpSimClient } from "../world/simClient";
import type { LookClient, LookOutcome } from "../world/lookClient";
import { redis } from "../redis/client";
import { sweepVisits } from "../jobs/visits";
import { clearPresence } from "../presence";

// The M4 gate, end to end with no browser: real gateway app (real auth, owners, visits, Postgres) -> production HTTP sim client ->
// real sim server -> real world (City 3 collision + navmesh). The sim is ticked by hand so the walk is fast and deterministic.
const SECRET = "x".repeat(48);
const ASSETS = new URL("../../../console/public/assets/", import.meta.url).pathname;
// The look service behind POST /world/see, faked at the client seam: records what the gateway asked for and answers a
// canned frame (or a failure, when lookMode flips) — the real service is a Chromium process, not a test dependency.
let lookMode: "ok" | "down" = "ok";
// While set, a capture waits on it: lets a test hold a photo mid-render.
let lookGate: Promise<void> | null = null;
let openGate: () => void = () => {};
const lookCalls: { agentId: string; position: [number, number]; headingDeg: number; gaze?: { yawDeg: number; pitchDeg: number } }[] = [];
const fakeLook: LookClient = {
  async look(agentId, position, headingDeg, gaze): Promise<LookOutcome> {
    lookCalls.push({ agentId, position, headingDeg, gaze });
    if (lookGate) await lookGate;
    if (lookMode === "down") return { ok: false, reason: "unavailable" };
    return {
      ok: true,
      serviceMs: 1234,
      frame: {
        photoPng: "aGVsbG8td29ybGQ=",
        width: 512,
        height: 288,
        depthSummary: { units: "m", median: 3.5, centreMedian: 4.25 },
        pose: { pos: [position[0], 0.2, position[1]] },
        renderMs: 1000,
        poseMs: 5,
        pitchSupported: false,
        capturedAt: "2026-11-12T00:00:00Z",
      },
    };
  },
};
let service: WorldService;
let clock = Date.now();
let simHttp: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof createApp>;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  // Owner registration is rate limited per IP in Redis (60/h); a test file that registers a few owners per run must not inherit earlier runs' count.
  const keys = await redis.keys("register:*");
  if (keys.length) await redis.del(...keys);
  const { sim } = await loadVerseSim(ASSETS);
  service = new WorldService({ sim, maxBodies: 5 });
  const simApp = createSimServer({ service, secret: SECRET, now: () => clock });
  simHttp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: simApp.fetch });
  app = createApp({ sim: httpSimClient(`http://127.0.0.1:${simHttp.port}`, SECRET), look: fakeLook });
  server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
}, 120_000);

afterAll(() => { server?.stop(true); simHttp?.stop(true); });

const json = (token?: string) => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });

async function ownerWithAgent(name: string) {
  const email = `world-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  const { token: ownerToken } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", { method: "POST", headers: json(ownerToken), body: JSON.stringify({ name: `${name}${Math.random().toString(36).slice(2, 7)}`, capabilities: [] }) });
  const { agent, agentToken } = (await created.json()) as any;
  await app.request(`/owners/agents/${agent.id}/wallet`, { method: "PATCH", headers: json(ownerToken), body: JSON.stringify({ autonomyMode: "autonomous" }) });
  return { ownerToken: ownerToken as string, agentId: agent.id as string, agentToken: agentToken as string, email };
}
const startVisit = async (ownerToken: string, agentId: string, maxActions = 50) =>
  ((await (await app.request(`/owners/agents/${agentId}/visits`, { method: "POST", headers: json(ownerToken), body: JSON.stringify({ minutes: 30, maxActions }) })).json()) as any).visit;

const w = (token: string, method: string, path: string, body?: unknown) =>
  app.request(`/world${path}`, { method, headers: json(token), body: body === undefined ? undefined : JSON.stringify(body) });

/** Walk the sim (0.5 s steps) and poll the act record through the gateway until it settles. */
async function settle(token: string, id: string, maxS = 240) {
  for (let t = 0; t < maxS; t += 0.5) {
    service.tick(0.5);
    await Promise.resolve();
    clock += 1000; // the sim's per-agent rate limit runs on this clock
    const rec = ((await (await w(token, "GET", `/act/${id}`)).json()) as any).act;
    if (rec?.state === "settled") return rec;
  }
  throw new Error(`action ${id} did not settle`);
}

describe("/world (agent body)", () => {
  test("no token -> 401; token but no visit -> 403 no_visit", async () => {
    expect((await w("", "GET", "/observe")).status).toBe(401);
    const { agentToken } = await ownerWithAgent("WorldNoVisit");
    const r = await w(agentToken, "POST", "/body");
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error).toBe("no_visit");
  });

  test("map: gates reject exactly like observe, and an active visit gets the places payload", async () => {
    // No token: 401, same as observe.
    expect((await w("", "GET", "/map")).status).toBe(401);

    // Unclaimed (self-registered, never claimed): 403 agent_unclaimed, identical to observe.
    const reg = await app.request("/agents/register", { method: "POST", headers: json(), body: JSON.stringify({ name: `WorldMapUnclaimed${Math.random().toString(36).slice(2, 7)}`, capabilities: [] }) });
    const { agentToken: unclaimedToken } = (await reg.json()) as any;
    const um = await w(unclaimedToken, "GET", "/map");
    const uo = await w(unclaimedToken, "GET", "/observe");
    expect(um.status).toBe(403);
    expect(((await um.json()) as any).error).toBe("agent_unclaimed");
    expect(uo.status).toBe(403);
    expect(((await uo.json()) as any).error).toBe("agent_unclaimed");

    // Claimed but no visit: 403 no_visit, identical to observe.
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldMap");
    const nm = await w(agentToken, "GET", "/map");
    expect(nm.status).toBe(403);
    expect(((await nm.json()) as any).error).toBe("no_visit");

    // Active visit: 200 with the same payload /places serves, Tea House included.
    await startVisit(ownerToken, agentId);
    const m = await w(agentToken, "GET", "/map");
    expect(m.status).toBe(200);
    const mapBody = (await m.json()) as any;
    const placesBody = (await (await w(agentToken, "GET", "/places")).json()) as any;
    expect(mapBody).toEqual(placesBody);
    expect(mapBody.places.some((p: any) => p.id === "shop-102" && p.name === "Matchmaker's Tea House")).toBe(true);

    // The playable clip names, through the same gates.
    const clips = (await (await w(agentToken, "GET", "/clips")).json()) as any;
    expect(clips.clips.some((c: any) => c.name === "Waving" && typeof c.loop === "boolean")).toBe(true);

    // Room ids are enumerable from the payload: a roomed place carries its interior
    // room id (the alternate go_to address), an unroomed place carries null — on both routes.
    for (const body of [mapBody, placesBody]) {
      expect(body.places.find((p: any) => p.id === "shop-102").room).toBe("tea");
      expect(body.places.find((p: any) => p.id === "stall-0").room).toBeNull();
    }
  });

  test("GET /body: 404 no_body before attach, the body's own state after, and it is free", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldBodyGet");
    const visit = await startVisit(ownerToken, agentId, 5);
    const before = await w(agentToken, "GET", "/body");
    expect(before.status).toBe(404);
    expect(((await before.json()) as any).error).toBe("no_body");
    expect((await w(agentToken, "POST", "/body")).status).toBe(201);
    clock += 1000;
    const after = await w(agentToken, "GET", "/body");
    expect(after.status).toBe(200);
    const b = ((await after.json()) as any).body;
    expect(b.posture).toBe("standing");
    expect(typeof b.x).toBe("number");
    const list = (await (await app.request(`/owners/agents/${agentId}/visits`, { headers: json(ownerToken) })).json()) as any;
    expect(list.visits.find((v: any) => v.id === visit.id).actionsUsed).toBe(1); // only the attach counted
  });

  test("a figure pick is honored and named; re-picking a different figure is a 409", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldFigure");
    await startVisit(ownerToken, agentId);

    const pick = await w(agentToken, "POST", "/body", { body: "summer" });
    expect(pick.status).toBe(201);
    expect(((await pick.json()) as any).observation.body.figure).toBe("summer");
    expect(((await (await w(agentToken, "GET", "/body")).json()) as any).body.figure).toBe("summer");
    expect(((await (await w(agentToken, "GET", "/observe")).json()) as any).observation.body.figure).toBe("summer");

    expect((await w(agentToken, "POST", "/body", { body: "summer" })).status).toBe(200); // same figure: idempotent
    expect((await w(agentToken, "POST", "/body", { body: "eve" })).status).toBe(409); // different figure on a live body
    expect(((await (await w(agentToken, "GET", "/body")).json()) as any).body.figure).toBe("summer"); // unchanged

    await w(agentToken, "DELETE", "/body"); // free the capped sim slot for later tests
  });

  test("owner default body: used when the agent names none; the agent's own pick wins; cast-only and foreign agents are refused", async () => {
    const a = await ownerWithAgent("WorldOwnerBody");
    const patch = (tok: string, id: string, body: unknown) => app.request(`/owners/agents/${id}/body`, { method: "PATCH", headers: json(tok), body: JSON.stringify({ body }) });
    // refused: cast-only (cast, mage, skeleton-warrior) and unknown, with the pickable set named
    for (const bad of ["cast", "mage", "skeleton-warrior", "nope", 3]) {
      const r = await patch(a.ownerToken, a.agentId, bad);
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).pickable).toContain("cipher");
    }
    // another owner cannot set it
    const other = await ownerWithAgent("WorldOwnerBodyOther");
    expect((await patch(other.ownerToken, a.agentId, "eve")).status).toBe(404);

    expect((await patch(a.ownerToken, a.agentId, "cipher")).status).toBe(200);
    const listed = ((await (await app.request("/owners/agents", { headers: json(a.ownerToken) })).json()) as any).agents.find((x: any) => x.id === a.agentId);
    expect(listed.body).toBe("cipher");

    await startVisit(a.ownerToken, a.agentId);
    const attach = await w(a.agentToken, "POST", "/body"); // names none -> the owner's default
    expect(attach.status).toBe(201);
    expect(((await attach.json()) as any).observation.body.figure).toBe("cipher");
    expect(service.roster().bodies.find((r) => r.agentId === a.agentId)?.body).toBe("cipher");
    await w(a.agentToken, "DELETE", "/body");

    // the agent's own pick wins over the owner's default
    const picked = await w(a.agentToken, "POST", "/body", { body: "eve" });
    expect(((await picked.json()) as any).observation.body.figure).toBe("eve");
    await w(a.agentToken, "DELETE", "/body");

    // clearing the default goes back to the platform default (remy)
    expect((await patch(a.ownerToken, a.agentId, null)).status).toBe(200);
    expect(((await (await w(a.agentToken, "POST", "/body")).json()) as any).observation.body.figure).toBe("remy");
    await w(a.agentToken, "DELETE", "/body");
  });

  test("an idle agent keeps its body while its visit is live (presence no longer reaps bodies)", async () => {
    // Regression (2026-11-11 loadtest §4): a REST-only agent that went
    // quiet lost its visit (presence_expired) and its body ~13 minutes
    // after its last call. The envelope governs now: quiet is not gone.
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldIdleBody");
    const visit = await startVisit(ownerToken, agentId, 5);
    expect((await w(agentToken, "POST", "/body")).status).toBe(201);
    clock += 1000;

    await clearPresence(agentId);
    await sweepVisits(); // marks offlineSince
    await db
      .update(agentVisits)
      .set({ offlineSince: new Date(Date.now() - 60 * 60_000) })
      .where(eq(agentVisits.id, visit.id));
    await sweepVisits(); // an hour quiet, under the old rule long past reaping

    const row = await db.query.agentVisits.findFirst({ where: eq(agentVisits.id, visit.id) });
    expect(row?.endedAt).toBeNull();
    expect((await w(agentToken, "GET", "/body")).status).toBe(200);

    // The file's sim is capped at 5 bodies and later tests attach their
    // own — leave the slot as this test found it.
    await w(agentToken, "DELETE", "/body");
  });

  test("extending a visit re-stamps the body's sim expiry to the new deadline", async () => {
    // The sim retires a body at the visit deadline it was attached
    // under. Without the re-stamp, an extended visit would read active
    // while its body died at the ORIGINAL deadline — the divergence the
    // loadtest found (bodies gone, visits active).
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldExtendRestamp");
    const started = await app.request(`/owners/agents/${agentId}/visits`, {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ minutes: 5, maxActions: 50 }),
    });
    const visit = ((await started.json()) as any).visit;
    expect((await w(agentToken, "POST", "/body")).status).toBe(201);

    const ext = await app.request(`/owners/agents/${agentId}/visits/${visit.id}/extend`, {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ minutes: 120 }),
    });
    expect(ext.status).toBe(200);
    // The re-stamp hook is fire-and-forget; give it a beat to land.
    await Bun.sleep(300);

    clock += 10 * 60_000; // past the ORIGINAL 5-minute deadline, well inside the extended one
    expect((await w(agentToken, "GET", "/body")).status).toBe(200);

    await w(agentToken, "DELETE", "/body"); // free the capped sim slot for later tests
  });

  test("cast-only and unknown picks are loud 400s naming the pickable set; no pick wears remy", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldPickBad");
    await startVisit(ownerToken, agentId);

    const cast = await w(agentToken, "POST", "/body", { body: "mage" });
    expect(cast.status).toBe(400);
    const castBody = (await cast.json()) as any;
    expect(castBody.error).toBe("body_not_pickable");
    expect(castBody.message).toContain("cast-only");
    expect(castBody.pickable).toContain("summer");

    const unknown = await w(agentToken, "POST", "/body", { body: "nope" });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as any).message).toContain("unknown body");

    expect((await w(agentToken, "GET", "/body")).status).toBe(404); // refused picks attached nothing

    const dflt = await w(agentToken, "POST", "/body");
    expect(dflt.status).toBe(201);
    expect(((await (await w(agentToken, "GET", "/body")).json()) as any).body.figure).toBe("remy");

    await w(agentToken, "DELETE", "/body");
  });

  test("visit counter: only a new accepted act counts (not a replay, a refused action or an id conflict)", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldCount");
    const visit = await startVisit(ownerToken, agentId, 50);
    const used = async () => ((await (await app.request(`/owners/agents/${agentId}/visits`, { headers: json(ownerToken) })).json()) as any)
      .visits.find((v: any) => v.id === visit.id).actionsUsed;
    expect((await w(agentToken, "POST", "/body")).status).toBe(201); // 1
    clock += 1000;
    expect((await w(agentToken, "POST", "/act", { id: "c-1", action: { type: "wait", seconds: 1 } })).status).toBe(202); // 2
    clock += 1000;
    expect((await w(agentToken, "POST", "/act", { id: "c-1", action: { type: "wait", seconds: 1 } })).status).toBe(200); // replay
    clock += 1000;
    expect((await w(agentToken, "POST", "/act", { id: "c-1", action: { type: "stop" } })).status).toBe(409);
    clock += 1000;
    expect((await w(agentToken, "POST", "/act", { id: "c-2", action: { type: "teleport", point: [0, 0] } })).status).toBe(400);
    expect(await used()).toBe(2);
  });

  test("GET /act/:id?waitMs holds until the act settles; waitMs=0 answers at once", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldLongPoll");
    await startVisit(ownerToken, agentId);
    expect((await w(agentToken, "POST", "/body")).status).toBe(201);
    clock += 1000;
    expect((await w(agentToken, "POST", "/act", { id: "lp-wait", action: { type: "wait", seconds: 2 } })).status).toBe(202);
    const now = (await (await w(agentToken, "GET", "/act/lp-wait?waitMs=0")).json()) as any;
    expect(now.act.state).toBe("running");
    // Tick the sim (and the rate-limit clock) in the background while the long-poll waits.
    const ticker = setInterval(() => { service.tick(0.5); clock += 500; }, 50);
    const t0 = Date.now();
    const held = (await (await w(agentToken, "GET", "/act/lp-wait?waitMs=8000")).json()) as any;
    clearInterval(ticker);
    expect(held.act.state).toBe("settled");
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  test("owner starts a visit, the agent attaches a body and walks to the Tea House door with no browser", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldWalker");
    await startVisit(ownerToken, agentId);

    const attach = await w(agentToken, "POST", "/body");
    expect(attach.status).toBe(201);
    expect(((await attach.json()) as any).observation.body.posture).toBe("standing");
    expect(service.has(agentId)).toBe(true);

    const places = (await (await w(agentToken, "GET", "/places")).json()) as any;
    expect(places.places.some((p: any) => p.id === "stall-0")).toBe(true);

    const accepted = await w(agentToken, "POST", "/act", { id: "go-tea", action: { type: "go_to", point: [-22.9, -75.0] } });
    expect(accepted.status).toBe(202);
    expect(((await accepted.json()) as any).act.state).toBe("running");

    // Same id, same action: the first record, not a second walk. Same id, other action: conflict.
    clock += 1000;
    expect((await w(agentToken, "POST", "/act", { id: "go-tea", action: { type: "go_to", point: [-22.9, -75.0] } })).status).toBe(200);
    clock += 1000;
    expect((await w(agentToken, "POST", "/act", { id: "go-tea", action: { type: "stop" } })).status).toBe(409);

    const done = await settle(agentToken, "go-tea");
    expect(done.outcome.status).toBe("arrived");
    const obs = ((await (await w(agentToken, "GET", "/observe")).json()) as any).observation;
    expect(Math.hypot(obs.body.x + 22.9, obs.body.z + 75.0)).toBeLessThan(1.5);
    expect(obs.lastAct.id).toBe("go-tea");

    // The owner stops the visit: the body goes with it.
    const visit = await startVisitLookup(ownerToken, agentId);
    const stop = await app.request(`/owners/agents/${agentId}/visits/${visit.id}/stop`, { method: "POST", headers: json(ownerToken) });
    expect(stop.status).toBe(200);
    await waitFor(() => !service.has(agentId));
    expect((await w(agentToken, "GET", "/observe")).status).toBe(403); // visit_ended
  }, 120_000);

  test("teleport and free text never reach the body; a missing id is refused at the gateway", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldBad");
    await startVisit(ownerToken, agentId);
    await w(agentToken, "POST", "/body");
    clock += 1000;
    expect((await w(agentToken, "POST", "/act", { id: "a1", action: { type: "teleport", point: [0, 0] } })).status).toBe(400);
    clock += 1000;
    expect((await w(agentToken, "POST", "/act", { id: "a2", action: { type: "chat", text: "hello" } })).status).toBe(400);
    expect((await w(agentToken, "POST", "/act", { id: "a2b", action: { type: "say", text: "x".repeat(141) } })).status).toBe(400);
    expect((await w(agentToken, "POST", "/act", { action: { type: "stop" } })).status).toBe(400);
    expect((await w(agentToken, "POST", "/act", { id: "../x", action: { type: "stop" } })).status).toBe(400);
    expect((await w(agentToken, "GET", "/act/..%2Fx")).status).toBe(400);
    await w(agentToken, "DELETE", "/body");
  });

  test("say: gated like a message, audited, carries the display name, and is heard by a neighbour with a cursor", async () => {
    const a = await ownerWithAgent("WorldSayA"), b = await ownerWithAgent("WorldSayB");
    await startVisit(a.ownerToken, a.agentId);
    await startVisit(b.ownerToken, b.agentId);
    await w(a.agentToken, "POST", "/body");
    // b stands 3 m from a in the open (attach is idempotent: the gateway's POST /body keeps this body)
    const at = service.body(a.agentId);
    service.attach(b.agentId, { x: at.x + 3, z: at.z });
    await w(b.agentToken, "POST", "/body");
    clock += 1000;
    const said = await w(a.agentToken, "POST", "/act", { id: "say1", action: { type: "say", text: "hello neighbour" } });
    expect(said.status).toBe(202);
    const rec = await settle(a.agentToken, "say1");
    expect(rec.outcome.ok).toBe(true);
    const seen = (await (await w(b.agentToken, "GET", "/observe")).json()) as { observation: { heard: { seq: number; text: string; name: string; untrusted: boolean }[] } };
    const line = seen.observation.heard.find((m) => m.text === "hello neighbour");
    expect(line, "neighbour heard it").toBeDefined();
    expect(line!.name).toContain("WorldSayA"); // the helper adds a random suffix to the name
    expect(line!.untrusted).toBe(true);
    const after = (await (await w(b.agentToken, "GET", `/observe?heardSince=${line!.seq}`)).json()) as { observation: { heard: unknown[] } };
    expect(after.observation.heard).toHaveLength(0);
    // 1 message per second per agent: an immediate second line is rate limited by the same gate as conversation messages
    const fast = await w(a.agentToken, "POST", "/act", { id: "say2", action: { type: "say", text: "again" } });
    expect([202, 429]).toContain(fast.status);
    await w(a.agentToken, "DELETE", "/body");
    await w(b.agentToken, "DELETE", "/body");
  }, 60_000);

  test("look: gateway forwards it, it counts as an action, and a second one inside a second is limited", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldLook");
    await startVisit(ownerToken, agentId);
    await w(agentToken, "POST", "/body");
    clock += 1000;
    const r = await w(agentToken, "POST", "/look", {});
    expect(r.status).toBe(200);
    const v = ((await r.json()) as { look: { width: number; height: number; legend: Record<string, string>; depthPng: string; observation: { heard: unknown[] } } }).look;
    expect([v.width, v.height]).toEqual([128, 72]);
    expect(v.legend["1"]).toBe("floor");
    expect(v.depthPng.length).toBeGreaterThan(100);
    expect(v.observation.heard).toEqual([]);
    expect((await w(agentToken, "POST", "/look", {})).status).toBe(429);
    await w(agentToken, "DELETE", "/body");
  });

  test("see: no visit -> 403 no_visit; visit without a body -> the sim's 404 no_body", async () => {
    const noVisit = await ownerWithAgent("SeeNoVisit");
    const r1 = await w(noVisit.agentToken, "POST", "/see", {});
    expect(r1.status).toBe(403);
    expect(((await r1.json()) as any).error).toBe("no_visit");
    const a = await ownerWithAgent("SeeNoBody");
    await startVisit(a.ownerToken, a.agentId);
    const r2 = await w(a.agentToken, "POST", "/see", {});
    expect(r2.status).toBe(404);
    expect(((await r2.json()) as any).error).toBe("no_body");
  });

  // POST /see answers 202 at once; the photo is read from GET /see/:id (long-poll).
  const readSee = async (token: string, id: string, waitMs = 5000) => ((await (await w(token, "GET", `/see/${id}?waitMs=${waitMs}`)).json()) as any).see;

  test("see: 202 at once, then the photograph from where the body stood, with its age and how far the body moved since", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("SeeHappy");
    await startVisit(ownerToken, agentId);
    const attach = await w(agentToken, "POST", "/body");
    expect(attach.status).toBe(201);
    const body = ((await attach.json()) as any).observation.body as { x: number; z: number; heading: number };
    clock += 1000;
    lookCalls.length = 0;
    const r = await w(agentToken, "POST", "/see", {});
    expect(r.status).toBe(202);
    const queued = ((await r.json()) as any).see as { id: string; state: string; requestedAt: number; pose: { x: number; z: number; headingDeg: number }; photoPng?: string };
    expect(queued.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(["queued", "running"]).toContain(queued.state);
    expect(queued.photoPng).toBeUndefined();
    expect(queued.pose.x).toBeCloseTo(body.x, 3);
    const see = await readSee(agentToken, queued.id);
    expect(see.state).toBe("done");
    expect(see.photoPng).toBe("aGVsbG8td29ybGQ=");
    expect([see.width, see.height]).toEqual([512, 288]);
    expect(see.depthSummary.median).toBe(3.5);
    expect(see.latencyMs).toBe(1234);
    expect(see.ageMs).toBeGreaterThanOrEqual(0);
    expect(see.moved).toEqual({ distanceM: 0, turnedDeg: 0 }); // the body stood still while the photo rendered
    // The gateway asked the service for the body's own pose (position from the sim, heading converted rad -> deg).
    expect(lookCalls).toHaveLength(1);
    expect(lookCalls[0].agentId).toBe(agentId);
    expect(lookCalls[0].position[0]).toBeCloseTo(body.x, 3);
    expect(lookCalls[0].position[1]).toBeCloseTo(body.z, 3);
    const wantDeg = (((body.heading * 180) / Math.PI) % 360 + 360) % 360;
    expect(Math.abs(lookCalls[0].headingDeg - wantDeg)).toBeLessThan(0.2);
    // Pacing: a second photograph inside the window is refused, not queued.
    expect((await w(agentToken, "POST", "/see", {})).status).toBe(429);
    // Only the owner of a job can read it.
    const other = await ownerWithAgent("SeeOther");
    await startVisit(other.ownerToken, other.agentId);
    expect((await w(other.agentToken, "GET", `/see/${queued.id}`)).status).toBe(404);
    expect((await w(agentToken, "GET", "/see/not-a-job")).status).toBe(404);
    await w(agentToken, "DELETE", "/body");
  });

  test("see: the head direction (gaze) travels with the request, and an out-of-range gaze is refused", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("SeeGaze");
    await startVisit(ownerToken, agentId);
    await w(agentToken, "POST", "/body");
    clock += 1000;
    expect((await w(agentToken, "POST", "/act", { id: "bad-gaze", action: { type: "gaze", pitchDeg: 90 } })).status).toBe(400);
    const g = await w(agentToken, "POST", "/act", { id: "g1", action: { type: "gaze", yawDeg: -25, pitchDeg: 15 } });
    expect(g.status).toBe(202);
    const poll = (await (await w(agentToken, "GET", "/act/g1?waitMs=3000")).json()) as any;
    expect(poll.act.outcome.status).toBe("done");
    expect(((await (await w(agentToken, "GET", "/observe")).json()) as any).observation.body.gaze).toEqual({ yawDeg: -25, pitchDeg: 15 });
    clock += 1000;
    lookCalls.length = 0;
    const r = await w(agentToken, "POST", "/see", {});
    expect(r.status).toBe(202);
    await readSee(agentToken, ((await r.json()) as any).see.id);
    expect(lookCalls[0].gaze).toEqual({ yawDeg: -25, pitchDeg: 15 });
    await w(agentToken, "DELETE", "/body");
  });

  test("see: while a photo renders the agent keeps acting, and a body that walked on says how far", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("SeeAsync");
    await startVisit(ownerToken, agentId);
    await w(agentToken, "POST", "/body");
    clock += 1000;
    lookGate = new Promise<void>((resolve) => { openGate = resolve; });
    try {
      const r = await w(agentToken, "POST", "/see", {});
      expect(r.status).toBe(202);
      const id = ((await r.json()) as any).see.id as string;
      // The render is held open: the job is still pending, and the agent can act meanwhile.
      expect((await readSee(agentToken, id, 0)).state).not.toBe("done");
      const act = await w(agentToken, "POST", "/act", { id: "walk-on", action: { type: "go_to", point: [10, 10] } });
      expect(act.status).toBe(202);
      for (let i = 0; i < 20; i++) { service.tick(0.5); clock += 500; }
      // A second request while one is in flight names the first.
      clock += 1000;
      const again = await w(agentToken, "POST", "/see", {});
      expect(again.status).toBe(429);
      expect(((await again.json()) as any).seeId).toBe(id);
      openGate();
      const see = await readSee(agentToken, id);
      expect(see.state).toBe("done");
      expect(typeof see.moved.distanceM).toBe("number");
    } finally {
      openGate?.(); lookGate = null;
    }
    await w(agentToken, "DELETE", "/body");
  });

  test("see: a down look service fails the job look_unavailable, and the failed see is not charged", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("SeeDown");
    const visit = await startVisit(ownerToken, agentId, 3); // attach (1) + see (1) + retry (1): a charged failure would leave no room, and the cap-reaching call ends the visit on the NEXT call, reads included
    await w(agentToken, "POST", "/body");
    clock += 1000;
    lookMode = "down";
    try {
      const r = await w(agentToken, "POST", "/see", {});
      expect(r.status).toBe(202);
      const see = await readSee(agentToken, ((await r.json()) as any).see.id);
      expect(see.state).toBe("failed");
      expect(see.error).toBe("look_unavailable");
    } finally {
      lookMode = "ok";
    }
    // Refunded: the failed see gave its action back, so a retry once the service is back is accepted instead of 403ing.
    clock += 1000;
    const retry = await w(agentToken, "POST", "/see", {});
    const retryBody = (await retry.json()) as any;
    expect([retry.status, retryBody.error]).toEqual([202, undefined]);
    expect((await readSee(agentToken, retryBody.see.id)).state).toBe("done");
    const after = await db.query.agentVisits.findFirst({ where: eq(agentVisits.id, visit.id) });
    expect(after?.actionsUsed).toBe(2);
    await w(agentToken, "DELETE", "/body");
  });

  test("see: a requested photo counts against the visit's action cap", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("SeeCounts");
    await startVisit(ownerToken, agentId, 2);
    await w(agentToken, "POST", "/body"); // 1
    clock += 1000;
    const r = await w(agentToken, "POST", "/see", {}); // 2 — cap reached
    expect(r.status).toBe(202);
    const id = ((await r.json()) as any).see.id as string;
    // Grace: the photo that reached the cap can still be collected (reading a result is not a new action)...
    expect((await readSee(agentToken, id)).state).toBe("done");
    // ...but anything else is refused, and that ends the visit; after that even the result read is refused.
    clock += 1000;
    const next = await w(agentToken, "POST", "/act", { id: "after-cap", action: { type: "wait", seconds: 1 } });
    expect(next.status).toBe(403);
    expect(((await next.json()) as any).reason).toBe("action_cap");
    expect((await w(agentToken, "GET", `/see/${id}`)).status).toBe(403);
  });

  test("act: the result of the cap-reaching act can be polled, and other reads are still refused", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("ActGrace");
    await startVisit(ownerToken, agentId, 2);
    await w(agentToken, "POST", "/body"); // 1
    const a = await w(agentToken, "POST", "/act", { id: "last-one", action: { type: "wait", seconds: 1 } }); // 2 — cap reached
    expect(a.status).toBe(202);
    const poll = await w(agentToken, "GET", "/act/last-one?waitMs=3000");
    expect(poll.status).toBe(200);
    // observe is not a result read: it ends the visit as before.
    const obs = await w(agentToken, "GET", "/observe");
    expect(obs.status).toBe(403);
    expect(((await obs.json()) as any).reason).toBe("action_cap");
  });

  test("deleting an owner whose agent had visits and a body succeeds and removes the body (was a 500: agent_visits FK)", async () => {
    const { ownerToken, agentId, agentToken, email } = await ownerWithAgent("WorldOwnerDelete");
    await startVisit(ownerToken, agentId);
    await w(agentToken, "POST", "/body");
    expect(service.has(agentId)).toBe(true);
    const r = await app.request("/owners/me", { method: "DELETE", headers: json(ownerToken), body: JSON.stringify({ confirmEmail: email }) });
    expect(r.status).toBe(200);
    await waitFor(() => !service.has(agentId));
  }, 30_000);

  test("pausing the agent removes its body and shuts the door", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldPaused");
    await startVisit(ownerToken, agentId);
    await w(agentToken, "POST", "/body");
    expect(service.has(agentId)).toBe(true);
    expect((await app.request(`/owners/agents/${agentId}/pause`, { method: "POST", headers: json(ownerToken) })).status).toBe(200);
    await waitFor(() => !service.has(agentId));
    const r = await w(agentToken, "GET", "/observe");
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error).toBe("agent_paused");
  });

  test("an observe without a body is a clean 404, and a dead sim is a 503, not a hang", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldNoBody");
    await startVisit(ownerToken, agentId);
    const r = await w(agentToken, "GET", "/observe");
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error).toBe("no_body");

    const dead = createApp({ sim: httpSimClient("http://127.0.0.1:1", SECRET, 500) });
    const t0 = performance.now();
    const d = await dead.request("/world/observe", { headers: json(agentToken) });
    expect(d.status).toBe(503);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  test("the sim refuses a wrong secret (misconfigured gateway answers 502, never leaks the sim)", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("WorldSecret");
    await startVisit(ownerToken, agentId);
    const wrong = createApp({ sim: httpSimClient(`http://127.0.0.1:${simHttp.port}`, "y".repeat(48)) });
    const r = await wrong.request("/world/observe", { headers: json(agentToken) });
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error).toBe("world_unavailable");
  });
});

describe("agent card", () => {
  test("advertises x-aiverse-world only when the world is enabled and configured", async () => {
    const card = async () => ((await (await app.request("/.well-known/agent-card.json")).json()) as any);
    const saved = { m: process.env.AIVERSE_WORLD_MODE, u: process.env.SIM_URL, s: process.env.SIM_INTERNAL_SECRET };
    try {
      delete process.env.AIVERSE_WORLD_MODE; delete process.env.SIM_URL; delete process.env.SIM_INTERNAL_SECRET;
      expect((await card())["x-aiverse-world"]).toBeUndefined();
      process.env.AIVERSE_WORLD_MODE = "1"; process.env.SIM_URL = "http://127.0.0.1:3020";
      expect((await card())["x-aiverse-world"]).toBeUndefined(); // no secret: not advertised
      process.env.SIM_INTERNAL_SECRET = SECRET;
      const w = (await card())["x-aiverse-world"];
      expect(w.endpoints.act).toContain("POST /world/act");
      expect(w.endpoints.body).toContain("GET /world/body");
      expect(w.actions.some((a: string) => a.startsWith("enter "))).toBe(true);
      expect(w.docs).toMatch(/\/llms\.txt$/);
      expect(JSON.stringify(w)).not.toContain(SECRET);
    } finally {
      for (const [k, v] of Object.entries({ AIVERSE_WORLD_MODE: saved.m, SIM_URL: saved.u, SIM_INTERNAL_SECRET: saved.s })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

test("GET /llms.txt is a public plain-text world guide listing every action type", async () => {
  const r = await app.request("/llms.txt");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/plain");
  const t = await r.text();
  for (const a of ["go_to", "enter", "face", "play", "say", "GET /world/clips", "waitMs", "heardSince", "untrusted", "POST /world/look", "6 door"]) expect(t).toContain(a);
});

async function startVisitLookup(ownerToken: string, agentId: string) {
  const list = (await (await app.request(`/owners/agents/${agentId}/visits`, { headers: json(ownerToken) })).json()) as any;
  return list.visits.find((v: any) => !v.endedAt);
}
async function waitFor(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(pred()).toBe(true);
}
