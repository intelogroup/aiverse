// The agent/visit lookup cache (auth/authCache.ts): reads stop hitting Postgres, and every path that must take effect at once still does.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../db/client";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { clearAuthCaches } from "../auth/authCache";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
afterAll(() => { server.stop(true); });
beforeEach(() => clearAuthCaches());

const json = (token?: string) => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });

async function ownerWithAgent(name: string) {
  const email = `authcache-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  const { token: ownerToken } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", { method: "POST", headers: json(ownerToken), body: JSON.stringify({ name: `${name}${Math.random().toString(36).slice(2, 8)}` }) });
  const { agent, agentToken } = (await created.json()) as any;
  return { ownerToken: ownerToken as string, agentId: agent.id as string, agentToken: agentToken as string };
}
const startVisit = (ownerToken: string, agentId: string, minutes: number, maxActions: number) =>
  app.request(`/owners/agents/${agentId}/visits`, { method: "POST", headers: json(ownerToken), body: JSON.stringify({ minutes, maxActions }) });
const read = (token: string) => app.request("/manifest", { headers: json(token) });
const write = (token: string) => app.request("/goals", { method: "POST", headers: json(token), body: JSON.stringify({ objective: "test objective for the cache" }) });
const owner = (ownerToken: string, path: string, method = "POST") => app.request(`/owners/agents/${path}`, { method, headers: json(ownerToken) });

/** Counts the two lookups every request used to repeat. */
function countLookups() {
  const n = { agent: 0, visit: 0 };
  const q = db.query as any;
  const a = q.agents.findFirst, v = q.agentVisits.findFirst;
  q.agents.findFirst = (...x: unknown[]) => { n.agent++; return a.apply(q.agents, x); };
  q.agentVisits.findFirst = (...x: unknown[]) => { n.visit++; return v.apply(q.agentVisits, x); };
  return { n, restore: () => { q.agents.findFirst = a; q.agentVisits.findFirst = v; } };
}

describe("reads stop hitting the database", () => {
  test("30 reads by one agent cost 29+ fewer agent lookups and visit lookups than the same reads with a cold cache", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("CacheReads");
    expect((await startVisit(ownerToken, agentId, 30, 100)).status).toBe(201);
    // The route's own handler also reads the agent, so compare against a cold cache instead of against zero.
    const run = async (cold: boolean) => {
      const c = countLookups();
      try {
        clearAuthCaches();
        for (let i = 0; i < 30; i++) {
          if (cold) clearAuthCaches();
          expect((await read(agentToken)).status).toBe(200);
        }
        return { ...c.n };
      } finally { c.restore(); }
    };
    const without = await run(true), withCache = await run(false);
    expect(without.agent - withCache.agent).toBeGreaterThanOrEqual(29);
    expect(without.visit - withCache.visit).toBeGreaterThanOrEqual(29);
  });
});

describe("what must take effect at once still does", () => {
  test("an owner stop refuses the very next read, inside the ttl", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("CacheStop");
    const { visit } = (await (await startVisit(ownerToken, agentId, 30, 100)).json()) as any;
    expect((await read(agentToken)).status).toBe(200);
    expect((await owner(ownerToken, `${agentId}/visits/${visit.id}/stop`)).status).toBe(200);
    const after = await read(agentToken);
    expect(after.status).toBe(403);
    expect(((await after.json()) as any).error).toBe("visit_ended");
  });

  test("the action cap still ends the visit when the count was cached: reads after the last write are refused", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("CacheCap");
    await startVisit(ownerToken, agentId, 30, 2);
    expect((await read(agentToken)).status).toBe(200);          // caches the visit at 0 of 2
    expect((await write(agentToken)).status).toBe(201);
    expect((await read(agentToken)).status).toBe(200);          // 1 of 2: still open
    expect((await write(agentToken)).status).toBe(201);         // 2 of 2
    const after = await read(agentToken);
    expect(after.status).toBe(403);
    expect(((await after.json()) as any).reason).toBe("action_cap");
  });

  test("a visit started after a stop is usable at once: an ended visit is never cached", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("CacheRestart");
    const { visit } = (await (await startVisit(ownerToken, agentId, 30, 100)).json()) as any;
    expect((await read(agentToken)).status).toBe(200);
    await owner(ownerToken, `${agentId}/visits/${visit.id}/stop`);
    expect((await read(agentToken)).status).toBe(403);
    expect((await startVisit(ownerToken, agentId, 30, 100)).status).toBe(201);
    expect((await read(agentToken)).status).toBe(200);
  });

  test("pausing an agent refuses its next read, and resuming lets it back", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("CachePause");
    await startVisit(ownerToken, agentId, 30, 100);
    expect((await read(agentToken)).status).toBe(200);
    expect((await owner(ownerToken, `${agentId}/pause`)).status).toBe(200);
    const paused = await read(agentToken);
    expect(paused.status).toBe(403);
    expect(((await paused.json()) as any).error).toBe("agent_paused");
    expect((await owner(ownerToken, `${agentId}/resume`)).status).toBe(200);
    expect((await read(agentToken)).status).toBe(200);
  });

  test("rotating the token refuses the old one at once and accepts the new one", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("CacheRotate");
    await startVisit(ownerToken, agentId, 30, 100);
    expect((await read(agentToken)).status).toBe(200);
    const rotated = await owner(ownerToken, `${agentId}/rotate-token`);
    expect(rotated.status).toBe(200);
    const { agentToken: fresh } = (await rotated.json()) as any;
    expect((await read(agentToken)).status).toBe(401);
    expect((await read(fresh)).status).toBe(200);
  });

  test("killing an agent refuses its next read", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("CacheKill");
    await startVisit(ownerToken, agentId, 30, 100);
    expect((await read(agentToken)).status).toBe(200);
    expect((await owner(ownerToken, `${agentId}/kill`)).status).toBe(200);
    expect((await read(agentToken)).status).toBe(401);
  });
});

describe("delete", () => {
  test("deleting an agent refuses its next read at once", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("CacheDelete");
    await startVisit(ownerToken, agentId, 30, 100);
    expect((await read(agentToken)).status).toBe(200);
    const del = await app.request(`/owners/agents/${agentId}`, { method: "DELETE", headers: json(ownerToken) });
    expect(del.status).toBeLessThan(300);
    expect((await read(agentToken)).status).toBe(401);
  });
});
