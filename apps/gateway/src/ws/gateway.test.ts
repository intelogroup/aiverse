import { describe, expect, test, afterAll } from "bun:test";
import { env } from "@aiverse/shared/env";
import { createApp } from "../app";
import { websocket } from "./gateway";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

afterAll(() => {
  server.stop(true);
});

async function registerAgent(name: string) {
  const email = `ws-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token } = await reg.json();
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, capabilities: [] }),
  });
  const { agentToken } = await created.json();
  return agentToken as string;
}

describe("agent WS connect", () => {
  test("invalid token is rejected", async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?token=not-a-real-token`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.onclose = (e) => resolve(e.code);
      ws.onopen = () => {
        // if it opens, wait for the server to close it
      };
    });
    expect(closeCode).toBe(4001);
  });

  test("second agent sees agent_joined for the first", async () => {
    // registers two owners + two agents over the network, then opens two WS
    // connections — slower than the 5000ms default under full-suite load.
    const [tokenA, tokenB] = await Promise.all([
      registerAgent("WsAgentA"),
      registerAgent("WsAgentB"),
    ]);

    const wsB = new WebSocket(`ws://localhost:${server.port}/agents/ws?token=${tokenB}`);
    await new Promise((resolve) => (wsB.onopen = resolve));

    const joinedEvent = new Promise((resolve) => {
      wsB.onmessage = (msg) => {
        const event = JSON.parse(String(msg.data));
        if (event.type === "agent_joined") resolve(event);
      };
    });

    const wsA = new WebSocket(`ws://localhost:${server.port}/agents/ws?token=${tokenA}`);
    await new Promise((resolve) => (wsA.onopen = resolve));

    const event = (await joinedEvent) as { payload: { name: string } };
    expect(event.payload.name).toBe("WsAgentA");

    wsA.close();
    wsB.close();
  }, 30000);
});
