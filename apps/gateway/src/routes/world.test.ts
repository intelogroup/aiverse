import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";
import { createSimServer } from "@aiverse/sim/server";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { httpSimClient } from "../world/simClient";
import { redis } from "../redis/client";

// The M4 gate, end to end with no browser: real gateway app (real auth, owners, visits, Postgres) -> production HTTP sim client ->
// real sim server -> real world (City 3 collision + navmesh). The sim is ticked by hand so the walk is fast and deterministic.
const SECRET = "x".repeat(48);
const ASSETS = new URL("../../../console/public/assets/", import.meta.url).pathname;
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
  app = createApp({ sim: httpSimClient(`http://127.0.0.1:${simHttp.port}`, SECRET) });
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
  return { ownerToken: ownerToken as string, agentId: agent.id as string, agentToken: agentToken as string };
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
    expect((await w(agentToken, "POST", "/act", { id: "go-tea", action: { type: "go_to", point: [-22.9, -75.0] } })).status).toBe(202);
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
    expect((await w(agentToken, "POST", "/act", { id: "a2", action: { type: "say", text: "hello" } })).status).toBe(400);
    expect((await w(agentToken, "POST", "/act", { action: { type: "stop" } })).status).toBe(400);
    expect((await w(agentToken, "POST", "/act", { id: "../x", action: { type: "stop" } })).status).toBe(400);
    expect((await w(agentToken, "GET", "/act/..%2Fx")).status).toBe(400);
    await w(agentToken, "DELETE", "/body");
  });

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
      expect(JSON.stringify(w)).not.toContain(SECRET);
    } finally {
      for (const [k, v] of Object.entries({ AIVERSE_WORLD_MODE: saved.m, SIM_URL: saved.u, SIM_INTERNAL_SECRET: saved.s })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
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
