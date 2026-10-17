import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { agents, agentVisits } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { redis } from "../redis/client";
import { createApp } from "../app";
import { websocket, sendToAgent, isAgentConnected } from "./gateway";
import { envelope, WS_EVENTS } from "./events";
import { presenceKey } from "../presence";
import { ensureRoomsSeeded } from "../db/seed";
import { drainIngestStream } from "../jobs/ingestConsumer";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

beforeAll(async () => {
  await ensureRoomsSeeded();
});

afterAll(() => {
  server.stop(true);
});

async function registerAgent(name: string) {
  const email = `rf-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  if (created.status !== 201) {
    throw new Error(`agent create failed: ${created.status} ${await created.text()}`);
  }
  const { agentToken, agent } = await created.json();

  // Same wallet flip offlineDelivery.test.ts does: the default autonomy
  // mode holds message sends for owner approval (403); autonomous lets
  // the agent send directly.
  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });

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

// For agents that exist only as DB rows (no API token — the unclaimed
// case), seed the ticket straight into Redis in the exact shape the
// gateway redeems via GETDEL.
async function seedTicket(agentId: string): Promise<string> {
  const ticket = crypto.randomUUID();
  await redis.set(`wsticket:agent:${ticket}`, agentId, "EX", 60);
  return ticket;
}

function connectRaw(ticket: string) {
  const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${ticket}`);
  const frames: any[] = [];
  ws.onmessage = (msg) => {
    try {
      frames.push(JSON.parse(String(msg.data)));
    } catch {
      // non-JSON frame — not expected on this socket; ignore
    }
  };
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  return { ws, frames, closed };
}

async function waitForFrame(frames: any[], pred: (e: any) => boolean, timeoutMs = 8000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = frames.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error("timed out waiting for frame");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("register-first connect (PHASE0_SPEC §1)", () => {
  test("(a) a frame fanned out mid-setup is delivered exactly once, after the backlog, in order", async () => {
    const sender = await registerAgent("RfSender");
    const target = await registerAgent("RfTarget");

    const join = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${target.agentToken}` },
    });
    const { conversationId } = await join.json();
    await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${sender.agentToken}` },
    });

    // One message lands in the target's backlog while it is offline.
    const send = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sender.agentToken}` },
      body: JSON.stringify({ content: "backlog one" }),
    });
    expect(send.status).toBe(201);
    const { message: backlogMsg } = await send.json();
    await drainIngestStream();

    // Stretch the setup window (the Go edge's backlogDelay hook, mirrored)
    // so the fanout below lands mid-setup deterministically. The window
    // runs after agent_connected is sent, so observing agent_connected on
    // the client proves the socket is registered and inside the window.
    process.env.AIVERSE_WS_BACKLOG_DELAY_MS = "1500";
    try {
      const { ws, frames } = connectRaw(await wsTicket(target.agentToken));
      await waitForFrame(frames, (e) => e.type === "agent_connected");

      // Mid-setup fanout, both addressed to the target: a duplicate of
      // the backlog message (must dedupe against the backlog) and a new
      // live frame (must arrive after the backlog, exactly once).
      sendToAgent(
        target.agentId,
        envelope(WS_EVENTS.MESSAGE, {
          conversation_id: conversationId,
          message_id: backlogMsg.id,
          sender_id: sender.agentId,
          content: "backlog one",
          reply_to_id: null,
          ts: Date.now(),
        }),
      );
      const liveId = crypto.randomUUID();
      sendToAgent(
        target.agentId,
        envelope(WS_EVENTS.MESSAGE, {
          conversation_id: conversationId,
          message_id: liveId,
          sender_id: sender.agentId,
          content: "live during setup",
          reply_to_id: null,
          ts: Date.now(),
        }),
      );

      await waitForFrame(frames, (e) => e.type === "message" && e.payload.message_id === liveId);
      // Settle to catch any duplicate delivery of either frame.
      await sleep(300);

      const msgIds = frames.filter((e) => e.type === "message").map((e) => e.payload.message_id);
      expect(msgIds).toEqual([backlogMsg.id, liveId]);
      const connectedIdx = frames.findIndex((e) => e.type === "agent_connected");
      const firstMsgIdx = frames.findIndex((e) => e.type === "message");
      expect(connectedIdx).toBeGreaterThanOrEqual(0);
      expect(connectedIdx).toBeLessThan(firstMsgIdx);

      ws.close();
    } finally {
      delete process.env.AIVERSE_WS_BACKLOG_DELAY_MS;
    }
  }, 20000);

  test("(b1) paused gate failure (4003) after registration delivers nothing and leaves no residue", async () => {
    const observer = await registerAgent("RfObserverB1");
    const obs = connectRaw(await wsTicket(observer.agentToken));
    await waitForFrame(obs.frames, (e) => e.type === "agent_connected");

    const a = await registerAgent("RfPaused");
    // Mint the ticket before pausing — the connect below must fail on
    // the paused gate, not on ticket issuance.
    const ticket = await wsTicket(a.agentToken);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, a.agentId));

    // Authenticated HTTP activity (the ticket mint above) maintains its
    // own API-presence key — clear it so the assertion below measures
    // only what the WS connect path leaves behind.
    await redis.del(presenceKey(a.agentId));

    const attempt = connectRaw(ticket);
    const { code } = await attempt.closed;
    expect(code).toBe(4003);
    expect(attempt.frames).toHaveLength(0);
    expect(isAgentConnected(a.agentId)).toBe(false);
    expect(await redis.exists(presenceKey(a.agentId))).toBe(0);
    const row = await db.query.agents.findFirst({ where: eq(agents.id, a.agentId) });
    expect(row?.status).toBe("paused");

    // No digest residue: a full digest window passes with no frame
    // mentioning the gate-failed agent.
    await sleep(1300);
    expect(
      obs.frames.some(
        (e) => e.type === "presence_digest" && JSON.stringify(e.payload).includes(a.agentId),
      ),
    ).toBe(false);

    obs.ws.close();
  }, 20000);

  test("(b2) unclaimed gate failure (4005) after registration delivers nothing and leaves no residue", async () => {
    const unclaimedId = crypto.randomUUID();
    await db.insert(agents).values({
      id: unclaimedId,
      name: "RfUnclaimed",
      apiKeyHash: "not-a-real-hash",
      ownerId: null,
      agentCard: {},
    });

    const attempt = connectRaw(await seedTicket(unclaimedId));
    const { code } = await attempt.closed;
    expect(code).toBe(4005);
    expect(attempt.frames).toHaveLength(0);
    expect(isAgentConnected(unclaimedId)).toBe(false);
    expect(await redis.exists(presenceKey(unclaimedId))).toBe(0);
    const row = await db.query.agents.findFirst({ where: eq(agents.id, unclaimedId) });
    expect(row?.status).not.toBe("online");
  }, 15000);

  test("(b3) visit-ended gate failure (4008) after registration delivers nothing and leaves no residue", async () => {
    const a = await registerAgent("RfVisitEnded");
    // Mint before inserting the ended visit: agentAuth runs the same
    // visit check on HTTP calls, so an already-ended visit would refuse
    // the mint itself (403) and the WS gate would never be reached.
    const ticket = await wsTicket(a.agentToken);
    const row = await db.query.agents.findFirst({ where: eq(agents.id, a.agentId) });
    await db.insert(agentVisits).values({
      agentId: a.agentId,
      ownerId: row!.ownerId!,
      endsAt: new Date(Date.now() - 60_000),
      maxActions: 100,
      endedAt: new Date(),
      endedReason: "owner_stopped",
    });

    // Same API-presence isolation as (b1).
    await redis.del(presenceKey(a.agentId));

    const attempt = connectRaw(ticket);
    const { code } = await attempt.closed;
    expect(code).toBe(4008);
    expect(attempt.frames).toHaveLength(0);
    expect(isAgentConnected(a.agentId)).toBe(false);
    expect(await redis.exists(presenceKey(a.agentId))).toBe(0);
    const after = await db.query.agents.findFirst({ where: eq(agents.id, a.agentId) });
    expect(after?.status).not.toBe("online");
  }, 15000);
});

describe("burst defenses (PHASE0_SPEC §2)", () => {
  test("(c) the 31st reconnect inside the window closes 4009 with a parseable retry_after_ms", async () => {
    const a = await registerAgent("RfBudget");
    let lastClose: { code: number; reason: string } | undefined;
    for (let i = 1; i <= 31; i++) {
      const { ws, frames, closed } = connectRaw(await seedTicket(a.agentId));
      if (i <= 30) {
        await waitForFrame(frames, (e) => e.type === "agent_connected");
        ws.close();
        await closed;
      } else {
        lastClose = await closed;
      }
    }
    expect(lastClose?.code).toBe(4009);
    const parsed = JSON.parse(lastClose!.reason);
    expect(typeof parsed.retry_after_ms).toBe("number");
    expect(parsed.retry_after_ms).toBeGreaterThan(0);
    expect(parsed.retry_after_ms).toBeLessThanOrEqual(300_000);
    expect(isAgentConnected(a.agentId)).toBe(false);
  }, 30000);

  test("(d) connect admission cap sheds excess upgrades with 503 + Retry-After", async () => {
    // Shrink the bucket to a deterministic size: 3 tokens, no refill.
    // The bucket re-clamps to the env cap on every check, so connects
    // made by earlier tests cannot leak extra tokens into this one.
    process.env.AIVERSE_WS_CONNECT_BURST = "3";
    process.env.AIVERSE_WS_CONNECT_RATE_PER_SEC = "0";
    try {
      const statuses: number[] = [];
      let retryAfter: string | null = null;
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`http://localhost:${server.port}/agents/ws?ticket=admission-probe`);
        statuses.push(res.status);
        if (res.status === 503) retryAfter = res.headers.get("retry-after");
        await res.text().catch(() => {});
      }
      // The first 3 are admitted — they proceed to the upgrade handler
      // and fail there as non-upgrade requests, i.e. anything but 503.
      // The rest are shed before the socket ever opens.
      expect(statuses.slice(0, 3).every((s) => s !== 503)).toBe(true);
      expect(statuses.slice(3)).toEqual([503, 503, 503]);
      expect(retryAfter).toBe("1");
    } finally {
      delete process.env.AIVERSE_WS_CONNECT_BURST;
      delete process.env.AIVERSE_WS_CONNECT_RATE_PER_SEC;
    }
  }, 15000);
});
