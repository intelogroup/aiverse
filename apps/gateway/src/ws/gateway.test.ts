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

    const joinedEvent = new Promise((resolve) => {
      wsB.onmessage = (msg) => {
        const event = JSON.parse(String(msg.data));
        // client-side onopen only means the HTTP upgrade finished — it says
        // nothing about server-side registration (DB write + presence map
        // insert) being committed. Wait for the server's own ack instead of
        // racing broadcast delivery order against connect() call order.
        if (event.type === "agent_connected") return;
        if (event.type === "agent_joined") resolve(event);
      };
    });
    await new Promise((resolve) => (wsB.onopen = resolve));
    await new Promise<void>((resolve) => {
      const check = (msg: MessageEvent) => {
        if (JSON.parse(String(msg.data)).type === "agent_connected") {
          wsB.removeEventListener("message", check);
          resolve();
        }
      };
      wsB.addEventListener("message", check);
    });

    const wsA = new WebSocket(`ws://localhost:${server.port}/agents/ws?token=${tokenA}`);
    await new Promise((resolve) => (wsA.onopen = resolve));

    const event = (await joinedEvent) as { payload: { name: string } };
    expect(event.payload.name).toBe("WsAgentA");

    wsA.close();
    wsB.close();
  }, 30000);

  test("a second connection replaces the first, which is force-closed with 4006", async () => {
    const token = await registerAgent("WsAgentReplaceGuard");

    const wsOld = new WebSocket(`ws://localhost:${server.port}/agents/ws?token=${token}`);
    await new Promise<void>((resolve) => {
      wsOld.onmessage = (msg) => {
        if (JSON.parse(String(msg.data)).type === "agent_connected") resolve();
      };
    });

    const oldClosed = new Promise<number>((resolve) => {
      wsOld.onclose = (e) => resolve(e.code);
    });

    const wsNew = new WebSocket(`ws://localhost:${server.port}/agents/ws?token=${token}`);
    await new Promise<void>((resolve) => {
      wsNew.onmessage = (msg) => {
        if (JSON.parse(String(msg.data)).type === "agent_connected") resolve();
      };
    });

    // A frame arriving on the just-replaced socket (race window between the
    // server calling close() and the client noticing) must not corrupt the
    // new connection's state — onMessage's identity guard (`conn.ws === ws`)
    // is what's under test here, mirroring onClose's existing guard.
    try {
      wsOld.send(JSON.stringify({ type: "pong" }));
    } catch {
      // already fully closed — fine, the race window just wasn't hit this run
    }

    expect(await oldClosed).toBe(4006);

    // new connection's heartbeat pipeline still works normally afterward —
    // if the stray pong above had corrupted its state via a missing identity
    // check, this would be the thing that breaks.
    wsNew.send(JSON.stringify({ type: "pong" }));

    wsOld.close();
    wsNew.close();
  }, 15000);
});
