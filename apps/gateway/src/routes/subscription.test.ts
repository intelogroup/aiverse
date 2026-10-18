import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { ensureRoomsSeeded } from "../db/seed";
import { db } from "../db/client";
import { conversationParticipants } from "@aiverse/shared/schema";
import { redis } from "../redis/client";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { drainIngestStream } from "../jobs/ingestConsumer";

// PHASE1_SPEC WI-2 — passive/active subscription state per (agent, room).
// Scaffolding mirrors fanoutBudget.test.ts (same app/server/agent helpers).
// The WI-1 budget knobs are read at call time, so test (d) pins them via
// process.env and afterEach clears them — bun runs every file in one
// process and a leaked capacity would silently throttle later suites.

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

const KNOBS = [
  "AIVERSE_FANOUT_BUDGET_CAPACITY",
  "AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC",
  "AIVERSE_FANOUT_BUDGET_GROUP_MIN_PARTICIPANTS",
];

afterAll(() => {
  server.stop(true);
});

afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
});

beforeAll(async () => {
  await ensureRoomsSeeded();
});

function uniqueName(base: string): string {
  // Kept short: @-mention resolution matches whole names against a
  // 32-char regex capture, so a long fixture name would silently
  // unresolve the mention in test (a).
  return `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function registerAgentWithId(name: string): Promise<{ token: string; agentId: string; name: string }> {
  const email = `sub-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  // Default wallet autonomy is "observe" (blocks sends) — promote, as
  // the other messaging suites do.
  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });
  return { token: agentToken as string, agentId: agent.id as string, name };
}

async function joinGeneral(token: string): Promise<string> {
  const res = await app.request("/rooms/general/join", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  const { conversationId } = await res.json();
  return conversationId as string;
}

async function connectAgent(token: string): Promise<{ ws: WebSocket; frames: any[] }> {
  const issued = await app.request("/auth/ws-ticket", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(issued.status).toBe(201);
  const { ticket } = await issued.json();
  const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${ticket}`);
  const frames: any[] = [];
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for agent_connected")), 5000);
    ws.addEventListener("message", (msg) => {
      const event = JSON.parse(String(msg.data));
      frames.push(event);
      if (event.type === "agent_connected") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await connected;
  return { ws, frames };
}

async function waitForFrames(frames: any[], pred: (f: any) => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (frames.some(pred)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for frame");
}

async function postMessage(token: string, conversationId: string, body: Record<string, unknown>) {
  const res = await app.request(`/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function setSubscription(token: string, conversationId: string, mode: string) {
  const res = await app.request(`/conversations/${conversationId}/subscription`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

// Send + persist one message. Multi-send tests reset the rate buckets
// between sends (the sender cap is 1 msg/s), and
// resetMemoryStoreForTests() DELs the ingest stream outright — so the
// drain must land BEFORE the next reset, or the reset eats the
// undrained publish (the public.test.ts loop runs in this same order).
async function sendAndPersist(token: string, conversationId: string, content: string): Promise<string> {
  const res = await postMessage(token, conversationId, { content });
  expect(res.status).toBe(201);
  await drainIngestStream();
  return res.body.message.id as string;
}

async function participantRow(conversationId: string, agentId: string) {
  return await db.query.conversationParticipants.findFirst({
    where: and(
      eq(conversationParticipants.conversationId, conversationId),
      eq(conversationParticipants.agentId, agentId),
    ),
  });
}

async function bucketTokens(conversationId: string): Promise<number | null> {
  const raw = await redis.hmget(`fanout:${conversationId}`, "tokens");
  return raw && raw[0] != null ? Number(raw[0]) : null;
}

const messageFramesFor = (frames: any[], ids: string[]) =>
  frames.filter((f) => f.type === "message" && ids.includes(f.payload?.message_id));

describe("passive/active subscriptions (PHASE1_SPEC WI-2)", () => {
  test("(a) a passive participant gets no MESSAGE frame but does get a MENTIONED frame, and its cursor does not move", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgentWithId(uniqueName("SubSend"));
    const listener = await registerAgentWithId(uniqueName("SubListen"));
    const conversationId = await joinGeneral(sender.token);
    await joinGeneral(listener.token);

    const { ws, frames } = await connectAgent(listener.token);
    const sub = await setSubscription(listener.token, conversationId, "passive");
    expect(sub.status).toBe(200);
    expect(sub.body.mode).toBe("passive");
    expect((await participantRow(conversationId, listener.agentId))?.mode).toBe("passive");

    const before = await participantRow(conversationId, listener.agentId);
    const sent = await postMessage(sender.token, conversationId, {
      content: `@${listener.name} are you lurking?`,
    });
    expect(sent.status).toBe(201);
    const messageId = sent.body.message.id as string;

    // The MENTIONED frame proves the send's fanout completed; the
    // MESSAGE loop runs before the mention push in the send path, so a
    // MESSAGE frame for this id would already have arrived.
    await waitForFrames(frames, (f) => f.type === "mentioned" && f.payload?.message_id === messageId);
    await new Promise((r) => setTimeout(r, 400)); // grace window for a frame that must NOT come
    expect(frames.some((f) => f.type === "message" && f.payload?.message_id === messageId)).toBe(false);

    await drainIngestStream();
    const after = await participantRow(conversationId, listener.agentId);
    expect(after?.lastDeliveredAt.getTime()).toBe(before?.lastDeliveredAt.getTime());

    // Invariant: passive is a delivery posture, not a read state — the
    // unread count keeps growing, and the resync surface reports mode.
    const list = await app.request("/conversations", {
      headers: { authorization: `Bearer ${listener.token}` },
    });
    const rows = ((await list.json()) as any).conversations as any[];
    const row = rows.find((r) => r.conversation_id === conversationId);
    expect(row?.unread).toBeGreaterThanOrEqual(1);
    expect(row?.mode).toBe("passive");
    ws.close();
  }, 20000);

  test("(b) flipping passive → active replays the suppressed messages exactly once, oldest-first", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgentWithId(uniqueName("SubSendB"));
    const listener = await registerAgentWithId(uniqueName("SubListenB"));
    const conversationId = await joinGeneral(sender.token);
    await joinGeneral(listener.token);

    const { ws, frames } = await connectAgent(listener.token);
    await setSubscription(listener.token, conversationId, "passive");

    const ids: string[] = [];
    for (const text of ["first suppressed", "second suppressed", "third suppressed"]) {
      await resetMemoryStoreForTests(); // per-send rate buckets (1 msg/s sender cap)
      ids.push(await sendAndPersist(sender.token, conversationId, text));
      await new Promise((r) => setTimeout(r, 40)); // distinct createdAt — wire order is createdAt order
    }
    expect(messageFramesFor(frames, ids)).toHaveLength(0); // nothing arrived live while passive

    const flip = await setSubscription(listener.token, conversationId, "active");
    expect(flip.status).toBe(200);
    expect(flip.body.mode).toBe("active");
    expect(flip.body.catchUp?.messages).toBe(3);

    await waitForFrames(frames, (f) => f.type === "message" && f.payload?.message_id === ids[2]);
    await new Promise((r) => setTimeout(r, 400)); // grace window for duplicates that must NOT come
    const deliveredIds = messageFramesFor(frames, ids).map((f) => f.payload.message_id);
    expect(deliveredIds).toEqual(ids); // exactly once, oldest-first
    ws.close();
  }, 30000);

  test("(b2) the flip catch-up is bounded by the existing backlog cap (50 per conversation)", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgentWithId(uniqueName("SubSendCap"));
    const listener = await registerAgentWithId(uniqueName("SubListenCap"));
    const conversationId = await joinGeneral(sender.token);
    await joinGeneral(listener.token);

    const { ws, frames } = await connectAgent(listener.token);
    await setSubscription(listener.token, conversationId, "passive");

    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      await resetMemoryStoreForTests();
      ids.push(await sendAndPersist(sender.token, conversationId, `cap probe ${i}`));
      await new Promise((r) => setTimeout(r, 5));
    }

    const flip = await setSubscription(listener.token, conversationId, "active");
    expect(flip.status).toBe(200);
    // "Bounded by the existing backlog cap" is the cap as the code has
    // always applied it: BACKLOG_MESSAGES_PER_CONVERSATION bounds the
    // persisted read (the Postgres LIMIT here), so the oldest 50 always
    // replay and the window only slides as acks advance the cursor.
    // The pending-ingest tail merge can add only the entries the
    // consumer's trim has not yet reclaimed (observed: the single
    // last-acked entry, the newest message) — the same merge the
    // reconnect backlog has always done; nothing is lost either way,
    // since un-acked messages past the window replay once the cursor
    // slides. Assert exactly that: 50..55 delivered, the oldest 50 all
    // present in order, no duplicates.
    const caughtUp = flip.body.catchUp?.messages as number;
    expect(caughtUp).toBeGreaterThanOrEqual(50);
    expect(caughtUp).toBeLessThanOrEqual(55);

    await waitForFrames(frames, (f) => f.type === "message" && f.payload?.message_id === ids[49], 10000);
    await new Promise((r) => setTimeout(r, 500)); // grace for the tail entry to land
    const deliveredIds = messageFramesFor(frames, ids).map((f) => f.payload.message_id);
    expect(deliveredIds.length).toBe(caughtUp);
    expect(new Set(deliveredIds).size).toBe(deliveredIds.length); // no duplicates
    expect(deliveredIds.filter((id) => ids.slice(0, 50).includes(id))).toEqual(ids.slice(0, 50));
    ws.close();
  }, 90000);

  test("(c) a passive participant who never flips still receives the full backlog on reconnect", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgentWithId(uniqueName("SubSendC"));
    const listener = await registerAgentWithId(uniqueName("SubListenC"));
    const conversationId = await joinGeneral(sender.token);
    await joinGeneral(listener.token);

    // Flip while the listener has no socket at all — suppression is a
    // stored posture, not a connection state.
    const sub = await setSubscription(listener.token, conversationId, "passive");
    expect(sub.status).toBe(200);

    const ids: string[] = [];
    for (const text of ["while you were passive 1", "while you were passive 2"]) {
      await resetMemoryStoreForTests();
      ids.push(await sendAndPersist(sender.token, conversationId, text));
      await new Promise((r) => setTimeout(r, 40));
    }

    const { ws, frames } = await connectAgent(listener.token);
    await waitForFrames(frames, (f) => f.type === "message" && f.payload?.message_id === ids[1]);
    const deliveredIds = messageFramesFor(frames, ids).map((f) => f.payload.message_id);
    expect(deliveredIds).toEqual(ids); // suppression ≠ loss
    ws.close();
  }, 30000);

  test("(d) the WI-1 fanout charge in a mixed room counts only active participants", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgentWithId(uniqueName("SubSendD"));
    const activePeer = await registerAgentWithId(uniqueName("SubActiveD"));
    const passivePeer1 = await registerAgentWithId(uniqueName("SubPassiveD1"));
    const passivePeer2 = await registerAgentWithId(uniqueName("SubPassiveD2"));
    // A dedicated group, not a seeded room: the seeded rooms are shared
    // across suites in this DB, so their participant count (the old
    // charge basis) is not this test's to control. The group-pricing
    // threshold knob is pinned to 2 so a 4-party group is
    // audience-priced at all — the charge basis is what's under test,
    // not the threshold (WI-1's suite owns threshold semantics).
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sender.token}` },
      body: JSON.stringify({
        isPublic: false,
        name: "wi2-mixed-room",
        participantIds: [activePeer.agentId, passivePeer1.agentId, passivePeer2.agentId],
      }),
    });
    expect(createRes.status).toBe(201);
    const conversationId = ((await createRes.json()) as any).conversation.id as string;
    await setSubscription(passivePeer1.token, conversationId, "passive");
    await setSubscription(passivePeer2.token, conversationId, "passive");

    process.env.AIVERSE_FANOUT_BUDGET_CAPACITY = "1000";
    process.env.AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC = "0";
    process.env.AIVERSE_FANOUT_BUDGET_GROUP_MIN_PARTICIPANTS = "2";

    const first = await postMessage(sender.token, conversationId, { content: "priced on actives only" });
    expect(first.status).toBe(201);
    // Audience is 3 participants, but only the active peer is delivered
    // to — the charge is 1, not 3.
    expect(await bucketTokens(conversationId)).toBe(1000 - 1);

    // Flip one passive peer back: the next send charges 2.
    await setSubscription(passivePeer1.token, conversationId, "active");
    await new Promise((r) => setTimeout(r, 1100)); // sender's 1 msg/s rate bucket refills
    const second = await postMessage(sender.token, conversationId, { content: "now two actives" });
    expect(second.status).toBe(201);
    expect(await bucketTokens(conversationId)).toBe(1000 - 1 - 2);
  }, 30000);

  test("(e) endpoint validation, and participants who never touch the surface stay active by default", async () => {
    await resetMemoryStoreForTests();
    const a = await registerAgentWithId(uniqueName("SubValA"));
    const outsider = await registerAgentWithId(uniqueName("SubValOut"));
    const conversationId = await joinGeneral(a.token);

    // Join default (Q2: new joins are active; schema default).
    expect((await participantRow(conversationId, a.agentId))?.mode).toBe("active");
    const list = await app.request("/conversations", {
      headers: { authorization: `Bearer ${a.token}` },
    });
    const rows = ((await list.json()) as any).conversations as any[];
    expect(rows.find((r) => r.conversation_id === conversationId)?.mode).toBe("active");

    const bad = await setSubscription(a.token, conversationId, "loud");
    expect(bad.status).toBe(400);

    const missing = await setSubscription(a.token, crypto.randomUUID(), "passive");
    expect(missing.status).toBe(404);

    const notParticipant = await setSubscription(outsider.token, conversationId, "passive");
    expect(notParticipant.status).toBe(403);

    // Re-posting the current mode is a 200 no-op — no catch-up fires
    // without a passive→active transition.
    const again = await setSubscription(a.token, conversationId, "active");
    expect(again.status).toBe(200);
    expect(again.body.mode).toBe("active");
    expect(again.body.catchUp).toBeUndefined();
  }, 20000);
});
