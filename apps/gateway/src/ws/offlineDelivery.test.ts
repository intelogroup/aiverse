import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createApp } from "../app";
import { websocket } from "./gateway";
import { ensureRoomsSeeded } from "../db/seed";
import { db } from "../db/client";
import { redis } from "../redis/client";
import { conversationParticipants, messages, messageTopics } from "@aiverse/shared/schema";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { drainIngestStream, recentCacheKey } from "../jobs/ingestConsumer"; // item 1: async persist, drain before reconnect backlog

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

// createApp() does not seed — index.ts does that at startup. Without this the
// file passes only when some earlier test file happened to seed the rooms
// first, and /rooms/general/join 404s on a fresh database (which is what CI
// gets every run).
beforeAll(async () => {
  await ensureRoomsSeeded();
});

afterAll(() => {
  server.stop(true);
});

async function registerAgent(name: string) {
  const email = `offline-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

  return { agentToken: agentToken as string, agentId: agent.id as string };
}

function waitFor(ws: WebSocket, predicate: (event: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for event")), timeoutMs);
    ws.onmessage = (msg) => {
      const event = JSON.parse(String(msg.data));
      if (predicate(event)) {
        clearTimeout(timer);
        resolve(event);
      }
    };
  });
}

function connectAndWaitOnline(agentToken: string): Promise<WebSocket> {
  return (async () => {
    // Single-use ticket per connect — the long-lived agent token stays out
    // of the query string.
    const res = await app.request("/auth/ws-ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(201);
    const ticket = ((await res.json()) as any).ticket as string;
    return await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${ticket}`);
      ws.onmessage = (msg) => {
        const event = JSON.parse(String(msg.data));
        if (event.type === "agent_connected") resolve(ws);
      };
    });
  })();
}

describe("offline delivery + ACK", () => {
  test("a message sent while the recipient is offline is replayed on reconnect, redelivered until acked, and stops once acked", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgent("OfflineSender");
    const recipient = await registerAgent("OfflineRecipient");

    const join = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${recipient.agentToken}` },
    });
    const { conversationId } = await join.json();
    await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${sender.agentToken}` },
    });

    // recipient is offline the entire time this message is sent
    const send = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sender.agentToken}` },
      body: JSON.stringify({ content: "you were offline for this" }),
    });
    expect(send.status).toBe(201);
    const { message } = await send.json();

    // Async persist (item 1): the reconnect backlog currently reads from
    // Postgres, so the message must land before the recipient reconnects.
    await drainIngestStream();

    // first reconnect: backlog replay delivers the missed message
    const ws1 = await connectAndWaitOnline(recipient.agentToken);
    const backlog1 = await waitFor(ws1, (e) => e.type === "message" && e.payload.message_id === message.id);
    expect(backlog1.payload.content).toBe("you were offline for this");
    ws1.close();
    await new Promise((r) => setTimeout(r, 100));

    // second reconnect, still no ack sent: same message replayed again —
    // proves the cursor only advances on explicit ack, not on delivery alone
    const ws2 = await connectAndWaitOnline(recipient.agentToken);
    const backlog2 = await waitFor(ws2, (e) => e.type === "message" && e.payload.message_id === message.id);
    expect(backlog2.payload.message_id).toBe(message.id);

    // now ack it
    ws2.send(JSON.stringify({ type: "ack", id: crypto.randomUUID(), ts: Date.now(), payload: { conversationId, messageId: message.id } }));
    await new Promise((r) => setTimeout(r, 200));
    ws2.close();
    await new Promise((r) => setTimeout(r, 100));

    // third reconnect: no redelivery this time
    const ws3 = await connectAndWaitOnline(recipient.agentToken);
    let redelivered = false;
    ws3.onmessage = (msg) => {
      const event = JSON.parse(String(msg.data));
      if (event.type === "message" && event.payload.message_id === message.id) redelivered = true;
    };
    await new Promise((r) => setTimeout(r, 500));
    expect(redelivered).toBe(false);
    ws3.close();
  }, 15000);

  test("a submitted A2A task addressed to an offline target is replayed on reconnect", async () => {
    await resetMemoryStoreForTests();
    const caller = await registerAgent("OfflineA2ACaller");
    const target = await registerAgent("OfflineA2ATarget");

    const res = await app.request(`/a2a/agents/${target.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${caller.agentToken}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { role: "user", parts: [{ kind: "text", text: "while you were out" }], messageId: "m1" } },
      }),
    });
    expect(res.status).toBe(200);
    const taskId = (await res.json()).result.id;

    const ws = await connectAndWaitOnline(target.agentToken);
    const pushed = await waitFor(ws, (e) => e.type === "a2a_task_request" && e.payload.taskId === taskId);
    expect(pushed.payload.fromAgentId).toBe(caller.agentId);
    ws.close();
  }, 15000);

  test("a peer joining a shared conversation while the recipient is offline is replayed on reconnect", async () => {
    // THREAD_PARTICIPANT_JOINED was fire-and-forget only (routes/rooms.ts,
    // routes/conversations.ts) — an offline participant never learned a peer
    // joined while they were away, the same silent-drop shape the message/
    // a2a-task backlog above already closed for other event types.
    await resetMemoryStoreForTests();
    const recipient = await registerAgent("JoinBacklogRecipient");
    const joiner = await registerAgent("JoinBacklogJoiner");

    const join = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${recipient.agentToken}` },
    });
    const { conversationId } = await join.json();

    // recipient never connects — joiner joins the same room while recipient
    // has no live socket at all, not just a disconnected one
    const joinerRes = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${joiner.agentToken}` },
    });
    expect(joinerRes.status).toBe(200);

    const ws = await connectAndWaitOnline(recipient.agentToken);
    const pushed = await waitFor(
      ws,
      (e) => e.type === "thread_participant_joined" && e.payload.agent_id === joiner.agentId,
    );
    expect(pushed.payload.conversation_id).toBe(conversationId);
    ws.close();
  }, 15000);
});

describe("reconnect backlog from the Redis recent-message cache (item 3)", () => {
  async function collectMessageEvents(ws: WebSocket, waitMs: number): Promise<any[]> {
    const events: any[] = [];
    ws.onmessage = (msg) => {
      const event = JSON.parse(String(msg.data));
      if (event.type === "message") events.push(event);
    };
    await new Promise((r) => setTimeout(r, waitMs));
    return events;
  }

  async function sendAs(token: string, conversationId: string, content: string) {
    const res = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { message: { id: string } };
  }

  test("backlog is served from the cache when Postgres has no rows: same wire format, own messages excluded, oldest-first", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgent("CacheBacklogSender");
    const recipient = await registerAgent("CacheBacklogRecipient");

    const join = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${recipient.agentToken}` },
    });
    const { conversationId } = (await join.json()) as { conversationId: string };
    await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${sender.agentToken}` },
    });

    // recipient briefly connects and sends its own message (must NOT be
    // redelivered to itself), then goes offline without acking
    const ws0 = await connectAndWaitOnline(recipient.agentToken);
    const ownMsg = await sendAs(recipient.agentToken, conversationId, "my own words");
    ws0.close();
    await new Promise((r) => setTimeout(r, 100));

    const firstMsg = await sendAs(sender.agentToken, conversationId, "first for you");
    // Per-agent send bucket: 1 msg/sec — space the sender's messages out.
    await new Promise((r) => setTimeout(r, 1100));
    const secondMsg = await sendAs(sender.agentToken, conversationId, "second for you");
    await drainIngestStream();

    // Cache holds all three, newest-first
    const cached = await redis.lrange(recentCacheKey(conversationId), 0, -1);
    expect(cached.length).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(cached[0]).content).toBe("second for you");

    // Cursor must sit at/after the oldest cached entry for the cache to
    // cover it: park it exactly on the recipient's own message (excluded
    // from delivery by the sender filter anyway).
    const own = await db.query.messages.findFirst({
      where: eq(messages.id, ownMsg.message.id),
    });
    expect(own).toBeDefined();
    await db
      .update(conversationParticipants)
      .set({ lastDeliveredAt: own!.createdAt })
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.agentId, recipient.agentId),
        ),
      );

    // Postgres rows vanish — the backlog must still arrive, complete and in
    // order, served from the cache alone (children first: FKs). Scoped to
    // this test's three messages: the general room is shared across files.
    const ids = [ownMsg.message.id, firstMsg.message.id, secondMsg.message.id];
    for (const id of ids) await db.delete(messageTopics).where(eq(messageTopics.messageId, id));
    for (const id of ids) await db.delete(messages).where(eq(messages.id, id));

    const ws = await connectAndWaitOnline(recipient.agentToken);
    const events = await collectMessageEvents(ws, 800);
    ws.close();

    expect(events.map((e) => e.payload.content)).toEqual(["first for you", "second for you"]);
    // Wire format identical to the Postgres path
    const p0 = events[0].payload;
    expect(p0.conversation_id).toBe(conversationId);
    expect(typeof p0.message_id).toBe("string");
    expect(p0.sender_id).toBe(sender.agentId);
    expect(p0.reply_to_id).toBeNull();
    expect(typeof p0.ts).toBe("number");
  }, 15000);

  test("cold cache falls back to Postgres without dropping the backlog", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgent("ColdCacheSender");
    const recipient = await registerAgent("ColdCacheRecipient");

    const join = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${recipient.agentToken}` },
    });
    const { conversationId } = (await join.json()) as { conversationId: string };
    await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${sender.agentToken}` },
    });

    await sendAs(sender.agentToken, conversationId, "survives a cold cache");
    await drainIngestStream();

    // Evict the cache entirely (cold start / Redis flush)
    await redis.del(recentCacheKey(conversationId));
    expect(await redis.lrange(recentCacheKey(conversationId), 0, -1)).toEqual([]);

    const ws = await connectAndWaitOnline(recipient.agentToken);
    const pushed = await waitFor(ws, (e) => e.type === "message" && e.payload.content === "survives a cold cache");
    expect(pushed.payload.sender_id).toBe(sender.agentId);
    ws.close();
  }, 15000);

  test("cursor older than the cache window falls back to Postgres instead of silently truncating", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgent("TrimmedCacheSender");
    const recipient = await registerAgent("TrimmedCacheRecipient");

    const join = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${recipient.agentToken}` },
    });
    const { conversationId } = (await join.json()) as { conversationId: string };
    await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${sender.agentToken}` },
    });

    // A message that predates the cache entirely (pre-item-1 era, or written
    // around the consumer): Postgres-only, never LPUSHed. Unique content so
    // reruns of this file don't see each other's rows.
    const tag = Date.now().toString(36);
    const ancientContent = `ancient message ${tag}`;
    const newContent = `new message ${tag}`;
    const ancientAt = new Date(Date.now() - 3_600_000);
    await db.insert(messages).values({
      conversationId,
      senderAgentId: sender.agentId,
      content: ancientContent,
      createdAt: ancientAt,
    });

    await sendAs(sender.agentToken, conversationId, newContent);
    await drainIngestStream();

    // Cache covers only the new message; park the cursor two hours back so
    // the cache provably cannot cover it.
    await db
      .update(conversationParticipants)
      .set({ lastDeliveredAt: new Date(Date.now() - 7_200_000) })
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.agentId, recipient.agentId),
        ),
      );

    const ws = await connectAndWaitOnline(recipient.agentToken);
    const events = await collectMessageEvents(ws, 800);
    ws.close();

    // Postgres fallback: the ancient message must be delivered, oldest-first
    // relative to the new one — a cache-only read would silently drop it.
    // (The general room is shared across files, so assert order relative to
    // this test's own messages, not the exact full sequence.)
    const contents = events.map((e) => e.payload.content);
    expect(contents).toContain(ancientContent);
    expect(contents).toContain(newContent);
    expect(contents.indexOf(ancientContent)).toBeLessThan(contents.indexOf(newContent));
  }, 15000);
});
