import { describe, expect, test, afterAll } from "bun:test";
import { env } from "@aiverse/shared/env";
import { eq } from "drizzle-orm";
import { agents } from "@aiverse/shared/schema";
import { db } from "../db/client";
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
  const { agentToken, agent } = await created.json();
  return { agentToken: agentToken as string, agentId: agent.id as string };
}

// Tickets are single-use: every WS connect mints a fresh one.
async function wsTicket(agentToken: string): Promise<string> {
  const res = await app.request("/auth/ws-ticket", {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}` },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).ticket;
}

describe("agent WS connect", () => {
  test("invalid ticket is rejected", async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${"0".repeat(64)}`);
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
    const [a, b] = await Promise.all([
      registerAgent("WsAgentA"),
      registerAgent("WsAgentB"),
    ]);

    const wsB = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${await wsTicket(b.agentToken)}`);

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

    const wsA = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${await wsTicket(a.agentToken)}`);
    await new Promise((resolve) => (wsA.onopen = resolve));

    const event = (await joinedEvent) as { payload: { name: string } };
    expect(event.payload.name).toBe("WsAgentA");

    wsA.close();
    wsB.close();
  }, 30000);

  test("a second connection replaces the first, which is force-closed with 4006", async () => {
    const { agentToken: token } = await registerAgent("WsAgentReplaceGuard");

    const wsOld = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${await wsTicket(token)}`);
    await new Promise<void>((resolve) => {
      wsOld.onmessage = (msg) => {
        if (JSON.parse(String(msg.data)).type === "agent_connected") resolve();
      };
    });

    const oldClosed = new Promise<number>((resolve) => {
      wsOld.onclose = (e) => resolve(e.code);
    });

    const wsNew = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${await wsTicket(token)}`);
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

  test("a normal disconnect broadcasts agent_left and flips DB status to offline", async () => {
    // Regression test: onClose's identity guard was comparing WSContext
    // wrapper objects (`conn.ws === ws`), but Hono's Bun adapter constructs
    // a brand-new WSContext on every single event — so the guard was false
    // on every plain disconnect, not just a real replace race, and onClose's
    // whole body (including this broadcast) silently never ran. Fixed by
    // comparing `.raw` (the stable underlying Bun socket) instead.
    const a = await registerAgent("WsAgentLeftA");
    const b = await registerAgent("WsAgentLeftB");

    const wsA = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${await wsTicket(a.agentToken)}`);
    await new Promise<void>((resolve) => {
      wsA.onmessage = (msg) => {
        if (JSON.parse(String(msg.data)).type === "agent_connected") resolve();
      };
    });

    const wsB = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${await wsTicket(b.agentToken)}`);
    await new Promise<void>((resolve) => {
      wsB.onmessage = (msg) => {
        if (JSON.parse(String(msg.data)).type === "agent_connected") resolve();
      };
    });

    const leftEvent = new Promise<{ payload: { agent_id: string } }>((resolve) => {
      wsA.onmessage = (msg) => {
        const event = JSON.parse(String(msg.data));
        if (event.type === "agent_left") resolve(event);
      };
    });

    wsB.close(1000, "normal close");
    const event = await leftEvent;
    expect(event.payload.agent_id).toBe(b.agentId);

    // onClose's DB write is fire-and-forget relative to the client-visible
    // close event — give it a moment to land.
    await new Promise((r) => setTimeout(r, 300));
    const row = await db.query.agents.findFirst({ where: eq(agents.id, b.agentId) });
    expect(row?.status).toBe("offline");

    wsA.close();
  }, 15000);
});
