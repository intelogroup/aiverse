import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createApp } from "../app";
import { websocket, handleAck } from "./gateway";
import { ensureRoomsSeeded } from "../db/seed";
import { db } from "../db/client";
import { redis } from "../redis/client";
import { conversationParticipants, messages, mentions } from "@aiverse/shared/schema";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { drainIngestStream } from "../jobs/ingestConsumer";
import {
  ackCursorKey,
  advanceAckCursor,
  getAckCursorMs,
  runAckCheckpoint,
} from "./ackCursors";

// Cursor acks v1 (ACK_CURSORS_V1.md §4 migration gates, PHASE1_SPEC
// WI-4 tests (a)–(e) + a legacy-mode rollback sanity check). The mode is
// read from the env at call time, so each test pins it explicitly and
// afterAll restores the default (dual).

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

beforeAll(async () => {
  await ensureRoomsSeeded();
});

afterAll(() => {
  delete process.env.AIVERSE_ACK_CURSOR_MODE;
  server.stop(true);
});

function setMode(mode: "legacy" | "dual" | "redis") {
  process.env.AIVERSE_ACK_CURSOR_MODE = mode;
}

async function registerAgent(name: string) {
  const email = `ackcursor-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });
  return { agentToken: agentToken as string, agentId: agent.id as string, name };
}

async function createDm(sender: { agentToken: string }, otherAgentId: string): Promise<string> {
  const res = await app.request("/conversations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sender.agentToken}` },
    body: JSON.stringify({ participantIds: [otherAgentId] }),
  });
  expect(res.status).toBe(201);
  const { conversation } = await res.json();
  return conversation.id as string;
}

async function createGroup(
  sender: { agentToken: string },
  participantIds: string[],
  name: string,
): Promise<string> {
  const res = await app.request("/conversations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sender.agentToken}` },
    body: JSON.stringify({ participantIds, kind: "group", name }),
  });
  expect(res.status).toBe(201);
  const { conversation } = await res.json();
  return conversation.id as string;
}

async function postMessage(
  sender: { agentToken: string },
  conversationId: string,
  content: string,
): Promise<{ id: string; createdAtMs: number }> {
  const res = await app.request(`/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sender.agentToken}` },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(201);
  const { message } = await res.json();
  return { id: message.id as string, createdAtMs: Date.parse(message.createdAt) };
}

interface Collector {
  events: any[];
  waitFor: (pred: (e: any) => boolean, timeoutMs?: number) => Promise<any>;
}

function collect(ws: WebSocket): Collector {
  const events: any[] = [];
  const waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];
  ws.onmessage = (msg) => {
    let event: any;
    try {
      event = JSON.parse(String(msg.data));
    } catch {
      return;
    }
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(event)) {
        const w = waiters[i];
        waiters.splice(i, 1);
        w.resolve(event);
      }
    }
  };
  return {
    events,
    waitFor: (pred, timeoutMs = 6000) =>
      new Promise((resolve, reject) => {
        const hit = events.find(pred);
        if (hit) return resolve(hit);
        const timer = setTimeout(() => reject(new Error("timed out waiting for event")), timeoutMs);
        waiters.push({
          pred,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      }),
  };
}

async function connectAgent(agentToken: string): Promise<{ ws: WebSocket } & Collector> {
  const res = await app.request("/auth/ws-ticket", {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}` },
  });
  expect(res.status).toBe(201);
  const ticket = ((await res.json()) as any).ticket as string;
  const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${ticket}`);
  const collector = collect(ws);
  await collector.waitFor((e) => e.type === "agent_connected");
  return { ws, ...collector };
}

function ackFrame(payload: Record<string, string>): string {
  return JSON.stringify({ type: "ack", id: crypto.randomUUID(), ts: Date.now(), payload });
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 6000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pgCursorMs(agentId: string, conversationId: string): Promise<number> {
  const row = await db.query.conversationParticipants.findFirst({
    where: and(
      eq(conversationParticipants.conversationId, conversationId),
      eq(conversationParticipants.agentId, agentId),
    ),
  });
  return row!.lastDeliveredAt.getTime();
}

async function setPgCursor(agentId: string, conversationId: string, tsMs: number): Promise<void> {
  await db
    .update(conversationParticipants)
    .set({ lastDeliveredAt: new Date(tsMs) })
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.agentId, agentId),
      ),
    );
}

async function insertMessage(
  conversationId: string,
  senderAgentId: string,
  content: string,
  createdAtMs: number,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(messages).values({
    id,
    conversationId,
    senderAgentId,
    content,
    createdAt: new Date(createdAtMs),
  });
  return id;
}

describe("cursor acks v1 (PHASE1_SPEC WI-4)", () => {
  test("(a) dual mode: an ack writes PG and advances the Redis cursor to the same value", async () => {
    await resetMemoryStoreForTests();
    setMode("dual");
    const sender = await registerAgent("AckDualSender");
    const recipient = await registerAgent("AckDualRecipient");
    const conversationId = await createDm(sender, recipient.agentId);

    const conn = await connectAgent(recipient.agentToken);
    const message = await postMessage(sender, conversationId, "dual mode ack target");
    await drainIngestStream();
    await conn.waitFor((e) => e.type === "message" && e.payload.message_id === message.id);

    conn.ws.send(ackFrame({ conversationId, messageId: message.id }));

    const redisMs = await pollUntil(
      () => getAckCursorMs(recipient.agentId, conversationId),
      (v) => v === message.createdAtMs,
    );
    expect(redisMs).toBe(message.createdAtMs);
    // §4 step 1 gate: sampled Redis cursor ≥ PG cursor (equal in dual —
    // both writes carry the same createdAt).
    const pgMs = await pgCursorMs(recipient.agentId, conversationId);
    expect(pgMs).toBe(message.createdAtMs);
    expect(redisMs!).toBeGreaterThanOrEqual(pgMs);
    conn.ws.close();
  });

  test("(b) redis mode: an ack performs zero PG writes and every reader sees the cursor immediately", async () => {
    await resetMemoryStoreForTests();
    setMode("redis");
    const sender = await registerAgent("AckRedisSender");
    const recipient = await registerAgent("AckRedisRecipient");
    const conversationId = await createDm(sender, recipient.agentId);

    const message = await postMessage(sender, conversationId, "redis mode ack target");
    await drainIngestStream();
    const pgBefore = await pgCursorMs(recipient.agentId, conversationId);
    expect(pgBefore).toBeLessThan(message.createdAtMs);

    const conn = await connectAgent(recipient.agentToken);
    await conn.waitFor((e) => e.type === "message" && e.payload.message_id === message.id);
    conn.ws.send(ackFrame({ conversationId, messageId: message.id }));

    await pollUntil(
      () => getAckCursorMs(recipient.agentId, conversationId),
      (v) => v === message.createdAtMs,
    );
    // Zero PG writes on the ack path: the durable cursor did not move.
    expect(await pgCursorMs(recipient.agentId, conversationId)).toBe(pgBefore);

    // Readers take max(PG, Redis) — the ack is visible immediately.
    const list = await app.request("/conversations", {
      headers: { authorization: `Bearer ${recipient.agentToken}` },
    });
    const { conversations } = await list.json();
    const row = (conversations as any[]).find((r) => r.conversation_id === conversationId);
    expect(row.unread).toBe(0);

    const unreadRes = await app.request(`/conversations/${conversationId}/messages?unread=true`, {
      headers: { authorization: `Bearer ${recipient.agentToken}` },
    });
    const unreadBody = await unreadRes.json();
    expect(unreadBody.messages).toHaveLength(0);

    // Backlog reader too: a reconnect must not replay the acked message.
    conn.ws.close();
    await sleep(300);
    const conn2 = await connectAgent(recipient.agentToken);
    await sleep(1500);
    expect(
      conn2.events.some((e) => e.type === "message" && e.payload.message_id === message.id),
    ).toBe(false);
    conn2.ws.close();

    // The checkpoint is what moves PG, with the same value.
    await runAckCheckpoint();
    expect(await pgCursorMs(recipient.agentId, conversationId)).toBe(message.createdAtMs);
  });

  test("(c) checkpoint: monotonic guard beats a newer PG cursor; dead keys are dropped", async () => {
    await resetMemoryStoreForTests();
    setMode("redis");
    const sender = await registerAgent("AckCkptSender");
    const recipient = await registerAgent("AckCkptRecipient");
    const conversationId = await createDm(sender, recipient.agentId);

    const t0 = Date.now() - 10_000;
    const t1 = t0 + 1_000;
    const t2 = t0 + 2_000;
    await setPgCursor(recipient.agentId, conversationId, t0);
    const m1 = await insertMessage(conversationId, sender.agentId, "older acked", t1);
    await insertMessage(conversationId, sender.agentId, "newer unacked", t2);

    await handleAck(recipient.agentId, { conversationId, messageId: m1 });
    await pollUntil(
      () => getAckCursorMs(recipient.agentId, conversationId),
      (v) => v === t1,
    );

    // Dual-mode race: PG already advanced past the Redis cursor.
    await setPgCursor(recipient.agentId, conversationId, t2);
    const first = await runAckCheckpoint();
    expect(first.keys).toBe(0);
    expect(await pgCursorMs(recipient.agentId, conversationId)).toBe(t2);

    // Dead keys: a cursor for a participant row that no longer exists,
    // and one for a conversation/agent pair that never existed. (A group,
    // not a second DM — the DM create is idempotent per pair and would
    // just return the first conversation.)
    const third = await registerAgent("AckCkptThird");
    const conversation2 = await createGroup(sender, [recipient.agentId, third.agentId], "ckpt dead keys");
    await advanceAckCursor(recipient.agentId, conversation2, t1, m1);
    await db
      .delete(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, conversation2),
          eq(conversationParticipants.agentId, recipient.agentId),
        ),
      );
    const ghostAgent = crypto.randomUUID();
    const ghostConversation = crypto.randomUUID();
    await advanceAckCursor(ghostAgent, ghostConversation, t1, m1);
    expect(await redis.sismember("ackcursor:dirty", `${recipient.agentId}:${conversation2}`)).toBe(1);
    expect(await redis.sismember("ackcursor:dirty", `${ghostAgent}:${ghostConversation}`)).toBe(1);

    await runAckCheckpoint();
    expect(await redis.sismember("ackcursor:dirty", `${recipient.agentId}:${conversation2}`)).toBe(0);
    expect(await redis.sismember("ackcursor:dirty", `${ghostAgent}:${ghostConversation}`)).toBe(0);
    expect(await redis.exists(ackCursorKey(recipient.agentId, conversation2))).toBe(0);
    expect(await redis.exists(ackCursorKey(ghostAgent, ghostConversation))).toBe(0);
  });

  test("(d) Redis-flush drill: after cursor loss, reconnect replays at most the un-checkpointed acks", async () => {
    await resetMemoryStoreForTests();
    setMode("redis");
    const sender = await registerAgent("AckFlushSender");
    const recipient = await registerAgent("AckFlushRecipient");
    const conversationId = await createDm(sender, recipient.agentId);

    const t0 = Date.now() - 20_000;
    await setPgCursor(recipient.agentId, conversationId, t0);
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) {
      ids.push(await insertMessage(conversationId, sender.agentId, `flush drill ${i}`, t0 + i * 1_000));
    }
    for (const id of ids) {
      await handleAck(recipient.agentId, { conversationId, messageId: id });
    }
    await pollUntil(
      () => getAckCursorMs(recipient.agentId, conversationId),
      (v) => v === t0 + 3_000,
    );
    await runAckCheckpoint();
    expect(await pgCursorMs(recipient.agentId, conversationId)).toBe(t0 + 3_000);

    // One more ack after the checkpoint — this is the only ack a Redis
    // loss is allowed to cost us (≤ one checkpoint interval, §3.5).
    const m4 = await insertMessage(conversationId, sender.agentId, "flush drill 4", t0 + 4_000);
    await handleAck(recipient.agentId, { conversationId, messageId: m4 });
    await pollUntil(
      () => getAckCursorMs(recipient.agentId, conversationId),
      (v) => v === t0 + 4_000,
    );

    await redis.del(ackCursorKey(recipient.agentId, conversationId));

    const conn = await connectAgent(recipient.agentToken);
    await sleep(2000);
    const replayed = conn.events
      .filter((e) => e.type === "message")
      .map((e) => e.payload.message_id);
    expect(replayed).toEqual([m4]);
    conn.ws.close();
  });

  test("(e) mention acks: checkpoint batch-marks ackedAt; early acks survive the persist window", async () => {
    await resetMemoryStoreForTests();
    setMode("redis");
    const sender = await registerAgent("AckMentionSender");
    const recipient = await registerAgent("AckMentionRecipient");
    const conversationId = await createDm(sender, recipient.agentId);

    const conn = await connectAgent(recipient.agentToken);

    // Persisted-row path: the ack lands in the Redis set only; the
    // checkpoint is what marks the row.
    await postMessage(sender, conversationId, `@${recipient.name} first ping`);
    await drainIngestStream();
    const mentionEvent1 = await conn.waitFor((e) => e.type === "mentioned");
    const mentionId1 = mentionEvent1.payload.mention_id as string;
    conn.ws.send(ackFrame({ mentionId: mentionId1 }));
    await pollUntil(
      () => redis.smembers(`ackmentions:${recipient.agentId}`),
      (v) => v.includes(mentionId1),
    );
    const rowBefore = await db.query.mentions.findFirst({ where: eq(mentions.id, mentionId1) });
    expect(rowBefore?.ackedAt).toBeNull();
    const ckpt = await runAckCheckpoint();
    expect(ckpt.mentions).toBeGreaterThanOrEqual(1);
    const rowAfter = await db.query.mentions.findFirst({ where: eq(mentions.id, mentionId1) });
    expect(rowAfter?.ackedAt).not.toBeNull();

    // Early-ack path: the live push carries the pre-generated mention id
    // before the consumer persists the row. The ack must stash AND join
    // the checkpoint set; once the row exists, the checkpoint lands it.
    // (Sleep past the 1 msg/s per-agent send-rate refill from post one.)
    await sleep(1100);
    await postMessage(sender, conversationId, `@${recipient.name} second ping`);
    const mentionEvent2 = await conn.waitFor(
      (e) => e.type === "mentioned" && e.payload.mention_id !== mentionId1,
    );
    const mentionId2 = mentionEvent2.payload.mention_id as string;
    conn.ws.send(ackFrame({ mentionId: mentionId2 }));
    await pollUntil(
      () => redis.exists(`earlyack:mention:${mentionId2}`),
      (v) => v === 1,
    );
    await pollUntil(
      () => redis.smembers(`ackmentions:${recipient.agentId}`),
      (v) => v.includes(mentionId2),
    );
    expect(await db.query.mentions.findFirst({ where: eq(mentions.id, mentionId2) })).toBeUndefined();
    await drainIngestStream();
    const persisted = await db.query.mentions.findFirst({ where: eq(mentions.id, mentionId2) });
    expect(persisted?.ackedAt).toBeNull();
    await runAckCheckpoint();
    const landed = await db.query.mentions.findFirst({ where: eq(mentions.id, mentionId2) });
    expect(landed?.ackedAt).not.toBeNull();

    // Neither mention replays on reconnect.
    conn.ws.close();
    await sleep(300);
    const conn2 = await connectAgent(recipient.agentToken);
    await sleep(1500);
    expect(conn2.events.some((e) => e.type === "mentioned")).toBe(false);
    conn2.ws.close();
  });

  test("(f) legacy mode: acks write PG only — no Redis cursor, the rollback path", async () => {
    await resetMemoryStoreForTests();
    setMode("legacy");
    const sender = await registerAgent("AckLegacySender");
    const recipient = await registerAgent("AckLegacyRecipient");
    const conversationId = await createDm(sender, recipient.agentId);

    const message = await postMessage(sender, conversationId, "legacy ack target");
    await drainIngestStream();
    await handleAck(recipient.agentId, { conversationId, messageId: message.id });

    expect(await pgCursorMs(recipient.agentId, conversationId)).toBe(message.createdAtMs);
    expect(await redis.exists(ackCursorKey(recipient.agentId, conversationId))).toBe(0);
  });
});
