import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { agentVisits } from "@aiverse/shared/schema";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";
import { createSimServer } from "@aiverse/sim/server";
import { createApp } from "../app";
import { db } from "../db/client";
import { httpSimClient } from "../world/simClient";
import { redis } from "../redis/client";
import { PRESENCE_MINUTES } from "./ownerWorld";

// Owner presence (routes/ownerWorld.ts): a signed-in owner's agent stands in the world inside a short, renewable visit.
const SECRET = "x".repeat(48);
const ASSETS = new URL("../../../console/public/assets/", import.meta.url).pathname;
let service: WorldService;
let simHttp: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const keys = await redis.keys("register:*");
  if (keys.length) await redis.del(...keys);
  const { sim } = await loadVerseSim(ASSETS);
  service = new WorldService({ sim, maxBodies: 10 });
  simHttp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createSimServer({ service, secret: SECRET, now: () => Date.now() }).fetch });
  app = createApp({ sim: httpSimClient(`http://127.0.0.1:${simHttp.port}`, SECRET) });
}, 120_000);
afterAll(() => { simHttp?.stop(true); });

const json = (token?: string) => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });
async function owner() {
  const email = `presence-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  return ((await reg.json()) as any).token as string;
}
async function agentOf(ownerToken: string) {
  const created = await app.request("/owners/agents", { method: "POST", headers: json(ownerToken), body: JSON.stringify({ name: `Pres${Math.random().toString(36).slice(2, 8)}`, capabilities: [] }) });
  return ((await created.json()) as any).agent.id as string;
}
const presence = (token: string, method = "POST") => app.request("/owners/world-presence", { method, headers: json(token) });
const activeVisit = (agentId: string) => db.query.agentVisits.findFirst({ where: and(eq(agentVisits.agentId, agentId), isNull(agentVisits.endedAt)) });
const hasBody = (agentId: string) => service.roster().bodies.some((b) => b.agentId === agentId);

describe("owner presence", () => {
  test("401 without an owner session", async () => {
    expect((await app.request("/owners/world-presence", { method: "POST" })).status).toBe(401);
  });

  test("an owner with no agent gets {agent:null} and nothing is created", async () => {
    const t = await owner();
    const r = await presence(t);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).agent).toBeNull();
  });

  test("starts a short visit and attaches the body; repeating is idempotent (one visit, one body)", async () => {
    const t = await owner();
    const id = await agentOf(t);
    const r1 = (await (await presence(t)).json()) as any;
    expect(r1.agent.id).toBe(id);
    expect(r1.attached).toBe(true);
    expect(hasBody(id)).toBe(true);
    const v1 = await activeVisit(id);
    expect(v1).toBeTruthy();
    expect(v1!.endsAt.getTime() - Date.now()).toBeLessThanOrEqual(PRESENCE_MINUTES * 60_000 + 1000);
    await presence(t);
    await presence(t);
    const all = await db.query.agentVisits.findMany({ where: eq(agentVisits.agentId, id) });
    expect(all.length).toBe(1);
    expect(service.roster().bodies.filter((b) => b.agentId === id).length).toBe(1);
  });

  test("the heartbeat renews a presence visit that is about to lapse", async () => {
    const t = await owner();
    const id = await agentOf(t);
    await presence(t);
    const v = (await activeVisit(id))!;
    await db.update(agentVisits).set({ endsAt: new Date(Date.now() + 20_000) }).where(eq(agentVisits.id, v.id));
    await presence(t);
    const after = (await activeVisit(id))!;
    expect(after.endsAt.getTime() - Date.now()).toBeGreaterThan(PRESENCE_MINUTES * 60_000 - 5_000);
  });

  test("after many heartbeats the visit is still ours: sign-out ends it and the deadline never drifts past two windows", async () => {
    const t = await owner();
    const id = await agentOf(t);
    for (let i = 0; i < 6; i++) {
      await presence(t);
      await db.update(agentVisits).set({ endsAt: new Date(Date.now() + 60_000) }).where(and(eq(agentVisits.agentId, id), isNull(agentVisits.endedAt)));
    }
    await presence(t);
    expect((await activeVisit(id))!.endsAt.getTime() - Date.now()).toBeLessThanOrEqual(2 * PRESENCE_MINUTES * 60_000);
    expect(((await (await presence(t, "DELETE")).json()) as any).ended).toBe(true);
  });

  test("a longer visit (owner or agent started) is reused, never extended, and not ended by sign-out", async () => {
    const t = await owner();
    const id = await agentOf(t);
    const start = await app.request(`/owners/agents/${id}/visits`, { method: "POST", headers: json(t), body: JSON.stringify({ minutes: 120, maxActions: 50 }) });
    expect(start.status).toBe(201);
    const before = (await activeVisit(id))!;
    const r = (await (await presence(t)).json()) as any;
    expect(r.attached).toBe(true);
    expect((await activeVisit(id))!.endsAt.getTime()).toBe(before.endsAt.getTime());
    const out = (await (await presence(t, "DELETE")).json()) as any;
    expect(out.ended).toBe(false);
    expect(await activeVisit(id)).toBeTruthy();
    expect(hasBody(id)).toBe(true);
  });

  test("sign-out ends a presence visit and the body leaves", async () => {
    const t = await owner();
    const id = await agentOf(t);
    await presence(t);
    expect(hasBody(id)).toBe(true);
    const out = (await (await presence(t, "DELETE")).json()) as any;
    expect(out.ended).toBe(true);
    expect(await activeVisit(id)).toBeUndefined();
    for (let i = 0; i < 20 && hasBody(id); i++) await Bun.sleep(50);
    expect(hasBody(id)).toBe(false);
  });

  test("a paused agent is not put in the world", async () => {
    const t = await owner();
    const id = await agentOf(t);
    const p = await app.request(`/owners/agents/${id}/pause`, { method: "POST", headers: json(t) });
    expect(p.status).toBe(200);
    const r = (await (await presence(t)).json()) as any;
    expect(r.agent).toBeNull();
    expect(hasBody(id)).toBe(false);
  });

  test("an owner only ever affects their own agents", async () => {
    const a = await owner();
    const b = await owner();
    const idA = await agentOf(a);
    const idB = await agentOf(b);
    await presence(a);
    expect(hasBody(idA)).toBe(true);
    expect(hasBody(idB)).toBe(false);
    await presence(b, "DELETE");
    expect(hasBody(idA)).toBe(true);
  });
});
