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

// Polls a collected-frames array until a frame matches (digest delivery
// is windowed, so frame waits are polls, not single onmessage promises).
async function waitForFrame(frames: any[], pred: (e: any) => boolean, timeoutMs = 8000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = frames.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error("timed out waiting for frame");
    await new Promise((r) => setTimeout(r, 25));
  }
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

  test("second agent sees the first in a presence_digest, not an agent_joined frame", async () => {
    // Presence joins no longer blast per-agent agent_joined frames
    // (FANOUT_FIX_SPEC): they collect at the gateway and flush as ONE
    // presence_digest per ~1s window. B must receive exactly that — a
    // digest whose joined[] carries A — and never an agent_joined frame.
    // Registers two owners + two agents over the network, then opens two
    // WS connections — slower than the 5000ms default under full-suite load.
    const [a, b] = await Promise.all([
      registerAgent("WsAgentA"),
      registerAgent("WsAgentB"),
    ]);

    // WI-3 (presence v2): digests are scoped to room co-members — A and
    // B must share a conversation for B to perceive A's join at all.
    // The digest mechanics under test (one netted frame, entry shape)
    // are unchanged.
    const convRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.agentToken}` },
      body: JSON.stringify({ participantIds: [b.agentId] }),
    });
    expect(convRes.status).toBe(201);

    const wsB = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${await wsTicket(b.agentToken)}`);
    const framesB: any[] = [];
    wsB.onmessage = (msg) => framesB.push(JSON.parse(String(msg.data)));
    await new Promise((resolve) => (wsB.onopen = resolve));
    // Client-side onopen only means the HTTP upgrade finished — it says
    // nothing about server-side registration being committed. Wait for
    // the server's own agent_connected ack before A connects, so A's join
    // is the one the assertions measure.
    await waitForFrame(framesB, (e) => e.type === "agent_connected");

    const wsA = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${await wsTicket(a.agentToken)}`);
    await new Promise((resolve) => (wsA.onopen = resolve));

    const digest = await waitForFrame(framesB, (e) => e.type === "presence_digest");
    expect(digest.payload.left).toEqual([]);
    expect(digest.payload.joined).toHaveLength(1);
    expect(digest.payload.joined[0].agent_id).toBe(a.agentId);
    expect(digest.payload.joined[0].name).toBe("WsAgentA");
    expect(Array.isArray(digest.payload.joined[0].capabilities)).toBe(true);

    // Give any (incorrectly) individual frames a full flush window to
    // show up, then assert none ever did — and that the one digest above
    // was the only one B received.
    await new Promise((r) => setTimeout(r, 1200));
    expect(framesB.some((e) => e.type === "agent_joined")).toBe(false);
    expect(framesB.filter((e) => e.type === "presence_digest")).toHaveLength(1);

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

  test("a normal disconnect lands in a presence_digest (left) and flips DB status to offline", async () => {
    // Regression test: onClose's identity guard was comparing WSContext
    // wrapper objects (`conn.ws === ws`), but Hono's Bun adapter constructs
    // a brand-new WSContext on every single event — so the guard was false
    // on every plain disconnect, not just a real replace race, and onClose's
    // whole body (including this broadcast) silently never ran. Fixed by
    // comparing `.raw` (the stable underlying Bun socket) instead. The
    // broadcast itself is now a presence_digest (FANOUT_FIX_SPEC): B's
    // departure must arrive in a digest's left[], never as an agent_left
    // frame. (If B's join and leave land in the same flush window they
    // net to just the left — also fine for these assertions.)
    const a = await registerAgent("WsAgentLeftA");
    const b = await registerAgent("WsAgentLeftB");

    // WI-3 (presence v2): digests are scoped to room co-members — A and
    // B must share a conversation for A to perceive B's departure.
    const convRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.agentToken}` },
      body: JSON.stringify({ participantIds: [b.agentId] }),
    });
    expect(convRes.status).toBe(201);

    const wsA = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${await wsTicket(a.agentToken)}`);
    const framesA: any[] = [];
    wsA.onmessage = (msg) => framesA.push(JSON.parse(String(msg.data)));
    await waitForFrame(framesA, (e) => e.type === "agent_connected");

    const wsB = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${await wsTicket(b.agentToken)}`);
    await new Promise<void>((resolve) => {
      wsB.onmessage = (msg) => {
        if (JSON.parse(String(msg.data)).type === "agent_connected") resolve();
      };
    });

    // Let B's join flush in its own window before disconnecting: digests
    // net per window, so a leave recorded in the same window as the join
    // would (correctly) net away to just the join and no left would ever
    // be owed. The instantaneous agent_left broadcast this test used to
    // assert on had no such window to respect.
    await new Promise((r) => setTimeout(r, 1500));

    wsB.close(1000, "normal close");
    const digest = await waitForFrame(framesA, (e) =>
      e.type === "presence_digest" && (e.payload.left ?? []).some((l: any) => l.agent_id === b.agentId),
    );
    expect(digest.payload.left).toContainEqual({ agent_id: b.agentId });
    expect(framesA.some((e) => e.type === "agent_left")).toBe(false);

    // onClose's DB write is fire-and-forget relative to the client-visible
    // close event — give it a moment to land.
    await new Promise((r) => setTimeout(r, 300));
    const row = await db.query.agents.findFirst({ where: eq(agents.id, b.agentId) });
    expect(row?.status).toBe("offline");

    wsA.close();
  }, 15000);
});
