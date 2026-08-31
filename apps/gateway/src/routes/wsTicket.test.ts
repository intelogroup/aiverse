import { describe, expect, test, afterAll } from "bun:test";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

afterAll(() => {
  server.stop(true);
});

async function registerAgent(name: string) {
  const email = `wsticket-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token: ownerToken } = await reg.json();
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name, capabilities: [] }),
  });
  const { agentToken, agent } = await created.json();
  return { agentToken: agentToken as string, agentId: agent.id as string, ownerToken: ownerToken as string };
}

function waitForEvent(ws: WebSocket, type: string, timeoutMs = 5000) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    ws.addEventListener("message", (msg) => {
      const event = JSON.parse(String(msg.data));
      if (event.type === type) {
        clearTimeout(timer);
        resolve(event);
      }
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 5000) {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for close")), timeoutMs);
    ws.addEventListener("close", (e) => {
      clearTimeout(timer);
      resolve(e.code);
    });
  });
}

describe("one-time WS tickets", () => {
  test("an agent ticket connects, then is single-use: replay closes with 4001", async () => {
    await resetMemoryStoreForTests();
    const { agentToken } = await registerAgent("WsTicketAgent1");

    const issued = await app.request("/auth/ws-ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(issued.status).toBe(201);
    const { ticket } = await issued.json();

    // First use: connects and receives agent_connected.
    const ws1 = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${ticket}`);
    await waitForEvent(ws1, "agent_connected");

    // Second use with the same ticket: GETDEL already consumed it, no token
    // fallback either (ticket path is terminal) — closed 4001.
    const ws2 = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${ticket}`);
    expect(await waitForClose(ws2)).toBe(4001);
    ws1.close();
  }, 10000);

  test("an unknown ticket closes with 4001", async () => {
    await resetMemoryStoreForTests();
    const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${"0".repeat(64)}`);
    expect(await waitForClose(ws)).toBe(4001);
  }, 10000);

  test("legacy ?token= still works during the transition", async () => {
    await resetMemoryStoreForTests();
    const { agentToken } = await registerAgent("WsTicketAgent2");
    const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?token=${agentToken}`);
    await waitForEvent(ws, "agent_connected");
    ws.close();
  }, 10000);

  test("owner ticket opens the console socket; a bad ticket closes with 4001", async () => {
    await resetMemoryStoreForTests();
    const email = `wsticket-owner-${Date.now()}@example.com`;
    const reg = await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    const { token: ownerToken } = await reg.json();

    const issued = await app.request("/owners/ws-ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(issued.status).toBe(201);
    const { ticket } = await issued.json();

    // Valid ticket: socket stays open (no immediate 4001 close).
    const ws1 = new WebSocket(`ws://localhost:${server.port}/console/ws?ticket=${ticket}`);
    let closedCode: number | null = null;
    ws1.addEventListener("close", (e) => {
      closedCode = e.code;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(closedCode).toBeNull();
    expect(ws1.readyState).toBe(ws1.OPEN);
    ws1.close();

    // Bad ticket: closed 4001.
    const ws2 = new WebSocket(`ws://localhost:${server.port}/console/ws?ticket=${"f".repeat(64)}`);
    expect(await waitForClose(ws2)).toBe(4001);
  }, 10000);

  test("issuing a ticket requires authentication", async () => {
    const res = await app.request("/auth/ws-ticket", { method: "POST" });
    expect(res.status).toBe(401);
  }, 10000);
});