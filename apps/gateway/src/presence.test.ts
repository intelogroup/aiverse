import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createApp } from "./app";
import { websocket } from "./ws/gateway";
import { ensureRoomsSeeded } from "./db/seed";
import { db } from "./db/client";
import { redis } from "./redis/client";
import { agents } from "@aiverse/shared/schema";
import { eq } from "drizzle-orm";
import { resetMemoryStoreForTests } from "./policy/memoryStore";
import {
  presenceKey,
  setPresence,
  clearPresence,
  isAgentOnline,
  getOnlineAgentIds,
  liveStatus,
  PRESENCE_TTL_SECONDS,
} from "./presence";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

beforeAll(async () => {
  await ensureRoomsSeeded();
});

afterAll(() => {
  server.stop(true);
});

async function registerAgent(name: string) {
  const email = `presence-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token: ownerToken } = (await reg.json()) as { token: string };
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name, capabilities: [] }),
  });
  const { agentToken, agent } = (await created.json()) as { agentToken: string; agent: { id: string } };
  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });
  return { agentToken, agentId: agent.id as string, name };
}

async function connectWs(agentToken: string): Promise<WebSocket> {
  const res = await app.request("/auth/ws-ticket", {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}` },
  });
  expect(res.status).toBe(201);
  const { ticket } = (await res.json()) as { ticket: string };
  return await new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timed out")), 5000);
    const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${ticket}`);
    ws.onmessage = (msg) => {
      const event = JSON.parse(String(msg.data));
      if (event.type === "agent_connected") {
        clearTimeout(timer);
        resolve(ws);
      }
    };
  });
}

describe("liveStatus", () => {
  test("deliberate states survive the overlay", () => {
    expect(liveStatus("paused", true)).toBe("paused");
    expect(liveStatus("budget_exhausted", true)).toBe("budget_exhausted");
    expect(liveStatus("unclaimed", true)).toBe("unclaimed");
  });

  test("transient states resolve through the TTL key", () => {
    expect(liveStatus("online", true)).toBe("online");
    expect(liveStatus("online", false)).toBe("offline");
    expect(liveStatus("offline", false)).toBe("offline");
    expect(liveStatus("away", true)).toBe("online");
    expect(liveStatus("away", false)).toBe("offline");
  });
});

describe("Redis presence keys (item 4)", () => {
  test("set/isAgentOnline/clear round-trip with TTL", async () => {
    const id = `test-agent-${Date.now()}`;
    expect(await isAgentOnline(id)).toBe(false);
    await setPresence(id);
    expect(await isAgentOnline(id)).toBe(true);
    const ttl = await redis.ttl(presenceKey(id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(PRESENCE_TTL_SECONDS);
    await clearPresence(id);
    expect(await isAgentOnline(id)).toBe(false);
  });

  test("getOnlineAgentIds returns exactly the keyed agents", async () => {
    const ids = [`pa-${Date.now()}-1`, `pa-${Date.now()}-2`];
    await setPresence(ids[0]);
    await setPresence(ids[1]);
    const online = await getOnlineAgentIds();
    expect(online.has(ids[0])).toBe(true);
    expect(online.has(ids[1])).toBe(true);
    await clearPresence(ids[0]);
    await clearPresence(ids[1]);
    const after = await getOnlineAgentIds();
    expect(after.has(ids[0])).toBe(false);
    expect(after.has(ids[1])).toBe(false);
  });
});

describe("presence-driven endpoints (item 4)", () => {
  test("WS connect sets the key; /rooms/:slug/presence and discover report online; close clears", async () => {
    await resetMemoryStoreForTests();
    const agent = await registerAgent("PresenceProbe");
    await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${agent.agentToken}` },
    });

    const ws = await connectWs(agent.agentToken);
    expect(await isAgentOnline(agent.agentId)).toBe(true);

    // discover overlay: live key beats the column
    const disc = await app.request(`/agents/discover?q=${agent.name}`);
    expect(disc.status).toBe(200);
    const entry = ((await disc.json()) as any).matches.find((m: any) => m.agentId === agent.agentId);
    expect(entry.status).toBe("online");

    // room presence counts the live agent
    const pres = await app.request("/rooms/general/presence");
    expect(pres.status).toBe(200);
    const body = (await pres.json()) as any;
    expect(body.connectedInVerse).toBeGreaterThanOrEqual(1);
    expect(body.active).toBe(body.connectedInVerse);

    ws.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(await isAgentOnline(agent.agentId)).toBe(false);
    // DB transition record still written on close (fallback/transitions)
    const row = await db.query.agents.findFirst({ where: eq(agents.id, agent.agentId), columns: { status: true } });
    expect(row?.status).toBe("offline");

    const disc2 = await app.request(`/agents/discover?q=${agent.name}`);
    const entry2 = ((await disc2.json()) as any).matches.find((m: any) => m.agentId === agent.agentId);
    expect(entry2.status).toBe("offline");
  }, 15000);

  test("paused agents keep their deliberate status in discover despite any key", async () => {
    await resetMemoryStoreForTests();
    const agent = await registerAgent("PausedProbe");
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agent.agentId));
    // even with a (stale) presence key, the deliberate state wins
    await setPresence(agent.agentId);
    const disc = await app.request(`/agents/discover?q=${agent.name}`);
    const entry = ((await disc.json()) as any).matches.find((m: any) => m.agentId === agent.agentId);
    expect(entry.status).toBe("paused");
    await clearPresence(agent.agentId);
  }, 15000);
});
