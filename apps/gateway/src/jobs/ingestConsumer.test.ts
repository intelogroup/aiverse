import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { db } from "../db/client";
import { messages, conversations, mentions } from "@aiverse/shared/schema";
import { redis } from "../redis/client";
import { uuidv7 } from "@aiverse/shared/uuidv7";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import {
  publishIngest,
  drainIngestStream,
  persistIngestBatch,
  INGEST_STREAM,
  CLASSIFY_STREAM,
  RECENT_CACHE_CAP,
  recentCacheKey,
  roomSeqKey,
  type IngestPublishFields,
} from "./ingestConsumer";

const app = createApp();

async function registerAgent(name: string): Promise<{ token: string; id: string }> {
  const email = `ingest-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  // Default wallet autonomy_mode is "observe" (blocks outbound sends) —
  // promote to autonomous like the other suites' helpers do.
  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });
  return { token: agentToken, id: agent.id };
}

async function makeConversation(token: string, isPublic: boolean): Promise<string> {
  const res = await app.request("/conversations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ isPublic, name: `ingest-test-${Date.now()}` }),
  });
  const { conversation } = (await res.json()) as { conversation: { id: string } };
  return conversation.id;
}

function fields(conversationId: string, senderAgentId: string, content: string, extra?: Partial<IngestPublishFields>): IngestPublishFields {
  return {
    id: uuidv7(),
    conversationId,
    senderAgentId,
    content,
    isPublic: true,
    ts: Date.now(),
    ...extra,
  };
}

describe("ingest buffer (item 1)", () => {
  test("publish lands in the stream immediately, Postgres only after drain", async () => {
    await resetMemoryStoreForTests();
    const { token, id: agentId } = await registerAgent("IngestPubAgent");
    const conversationId = await makeConversation(token, true);

    const send = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "buffered hello" }),
    });
    expect(send.status).toBe(201);
    const { message } = (await send.json()) as { message: { id: string; content: string } };
    expect(message.content).toBe("buffered hello");
    expect(message.id).toBeDefined();

    // Visible to the consumer immediately (the stream), invisible to
    // Postgres until the leader's batch persist runs.
    expect(await redis.xlen(INGEST_STREAM)).toBeGreaterThan(0);
    const before = await db.query.messages.findFirst({ where: eq(messages.id, message.id) });
    expect(before).toBeUndefined();

    await drainIngestStream();
    const after = await db.query.messages.findFirst({ where: eq(messages.id, message.id) });
    expect(after).not.toBeNull();
    expect(after!.content).toBe("buffered hello");
  });

  test("created_at keeps millisecond precision from the publish timestamp", async () => {
    await resetMemoryStoreForTests();
    const { token, id: agentId } = await registerAgent("IngestTsAgent");
    const conversationId = await makeConversation(token, true);
    const f = fields(conversationId, agentId, "ts check");
    await publishIngest(f);
    await drainIngestStream();
    const row = await db.query.messages.findFirst({ where: eq(messages.id, f.id) });
    expect(row).not.toBeNull();
    expect(row!.createdAt.getTime()).toBe(f.ts);
  });

  test("idempotent replay: same entry persisted twice inserts once, derives once", async () => {
    await resetMemoryStoreForTests();
    const { token, id: agentId } = await registerAgent("IngestReplayAgent");
    const conversationId = await makeConversation(token, true);
    const f = fields(conversationId, agentId, "replay me", {
      attachments: [{ url: "https://example.com/a", title: "a", type: "link" }],
    });

    // Simulate a crash between Postgres commit and XACK: the same entry is
    // delivered (and persisted) twice. Second persist must be a no-op.
    const entry = { ...f, streamId: "1-0" } as Parameters<typeof persistIngestBatch>[0][number];
    const first = await persistIngestBatch([entry]);
    expect(first.inserted).toBe(1);
    const second = await persistIngestBatch([{ ...entry, streamId: "1-1" }]);
    expect(second.inserted).toBe(0);

    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, conversationId) });
    expect(rows).toHaveLength(1);
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
    expect(conv!.messageCount).toBe(1); // not double-counted
    expect(await redis.llen(recentCacheKey(conversationId))).toBe(1); // cache not doubled
  });

  test("recent cache is populated newest-first and capped", async () => {
    await resetMemoryStoreForTests();
    const { token, id: sender } = await registerAgent("IngestCacheAgent");
    const conversationId = await makeConversation(token, true);

    const total = RECENT_CACHE_CAP + 10;
    for (let i = 0; i < total; i++) {
      await publishIngest(fields(conversationId, sender, `cached ${i}`));
    }
    await drainIngestStream();

    const len = await redis.llen(recentCacheKey(conversationId));
    expect(len).toBe(RECENT_CACHE_CAP);
    const newest = await redis.lindex(recentCacheKey(conversationId), 0);
    expect(JSON.parse(newest!).content).toBe(`cached ${total - 1}`);
    const oldest = await redis.lindex(recentCacheKey(conversationId), -1);
    expect(JSON.parse(oldest!).content).toBe(`cached ${total - RECENT_CACHE_CAP}`);
  });

  test("classify feed receives public messages only", async () => {
    await resetMemoryStoreForTests();
    const { token, id: sender } = await registerAgent("IngestClassifyAgent");
    const publicId = await makeConversation(token, true);
    const privateId = await makeConversation(token, false);

    await publishIngest(fields(publicId, sender, "public content", { isPublic: true }));
    await publishIngest(fields(privateId, sender, "private content", { isPublic: false }));
    await drainIngestStream();

    const entries = await redis.xrange(CLASSIFY_STREAM, "-", "+");
    const contents = entries.map(([, flat]) => {
      const m = new Map<string, string>();
      for (let i = 0; i + 1 < flat.length; i += 2) m.set(flat[i], flat[i + 1]);
      return m.get("content");
    });
    expect(contents).toContain("public content");
    expect(contents).not.toContain("private content");
  });

  test("room sequence counter increments once per batch with inserts", async () => {
    await resetMemoryStoreForTests();
    const { token, id: sender } = await registerAgent("IngestSeqAgent");
    const conversationId = await makeConversation(token, true);

    await publishIngest(fields(conversationId, sender, "one"));
    await publishIngest(fields(conversationId, sender, "two"));
    const drained = await drainIngestStream();
    expect(drained).toBe(2);
    expect(await redis.get(roomSeqKey(conversationId))).toBe("1"); // one batch, one incr

    await publishIngest(fields(conversationId, sender, "three"));
    await drainIngestStream();
    expect(await redis.get(roomSeqKey(conversationId))).toBe("2");
  });

  test("message_count increments once per conversation per batch", async () => {
    await resetMemoryStoreForTests();
    const { token, id: sender } = await registerAgent("IngestCountAgent");
    const conversationId = await makeConversation(token, true);

    await publishIngest(fields(conversationId, sender, "a"));
    await publishIngest(fields(conversationId, sender, "b"));
    await publishIngest(fields(conversationId, sender, "c"));
    await drainIngestStream();
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
    expect(conv!.messageCount).toBe(3);
  });

  test("@-mention rows persist via the consumer after the message row exists (FK)", async () => {
    await resetMemoryStoreForTests();
    // Unique names per run: Postgres is NOT reset between runs, and mention
    // resolution is name-based — a fixed name would match agents from
    // earlier runs and produce multiple rows.
    const suffix = Date.now().toString(36);
    const { token } = await registerAgent(`IngestMentionSender${suffix}`);
    const target = await registerAgent(`IngestMentionTarget${suffix}`);
    const conversationId = await makeConversation(token, true);

    const send = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: `@ingestmentiontarget${suffix} hello there` }),
    });
    expect(send.status).toBe(201);
    const { message } = (await send.json()) as { message: { id: string } };

    // The live WS push already went out (not asserted here — covered by
    // mentions.test.ts); the durable row rides the stream with the message.
    await drainIngestStream();
    const rows = await db.query.mentions.findMany({ where: eq(mentions.messageId, message.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetAgentId).toBe(target.id);
    expect(rows[0]!.byName).toBe(`IngestMentionSender${suffix}`);
  });

  test("clientMessageId conflict loser plants no phantom cache entry or classify job", async () => {
    // Two stream entries, same (conversation, sender, clientMessageId), two
    // pre-generated ids: simulates a retry that re-published after the NX
    // reservation expired. Stream order decides — the first XADD wins the
    // consumer's ON CONFLICT DO NOTHING; the loser must not leak into any
    // derived Redis state (a phantom recent-cache entry would be served by
    // the reconnect backlog; a classify-feed entry would FK-violate the
    // worker and wedge its batch).
    await resetMemoryStoreForTests();
    const agent = await registerAgent(`ConflictLoser${Date.now().toString(36)}`);
    const conversationId = await makeConversation(agent.token, true);
    const key = `conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const winnerId = uuidv7();
    const loserId = uuidv7();
    const now = Date.now();
    await publishIngest(fields(conversationId, agent.id, "winner", { id: winnerId, clientMessageId: key, ts: now }));
    await publishIngest(fields(conversationId, agent.id, "loser", { id: loserId, clientMessageId: key, ts: now }));
    await drainIngestStream();

    // Postgres: exactly one row — the winner.
    const rows = await db.query.messages.findMany({ where: eq(messages.clientMessageId, key) });
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(winnerId);

    // Recent cache: the winner exactly once, the loser nowhere.
    const cached = await redis.lrange(recentCacheKey(conversationId), 0, -1);
    const cachedIds = cached.map((c) => (JSON.parse(c) as { id: string }).id);
    expect(cachedIds).toEqual([winnerId]);

    // Classify feed: exactly one job, the winner's.
    const feed = (await redis.xrange(CLASSIFY_STREAM, "-", "+", "COUNT", 100)) as Array<[string, string[]]>;
    const feedIds = feed.map(([, flat]) => {
      const m = new Map<string, string>();
      for (let i = 0; i + 1 < flat.length; i += 2) m.set(flat[i], flat[i + 1]);
      return m.get("messageId");
    });
    expect(feedIds).toEqual([winnerId]);

    // Room sequence: one increment for the batch's live entry, not two.
    expect(await redis.get(roomSeqKey(conversationId))).toBe("1");
  });

  test("poison entry (FK violation) is quarantined without wedging the stream", async () => {
    // A runId for a nonexistent run FK-violates the batch insert. The batch
    // falls back to solo persists: the good entry lands normally, the poison
    // is acked + listed + logged instead of failing every batch forever
    // (which would wedge the stream — sends keep 201-ing while nothing
    // persists).
    await resetMemoryStoreForTests();
    const agent = await registerAgent(`Poison${Date.now().toString(36)}`);
    const conversationId = await makeConversation(agent.token, true);
    const goodId = uuidv7();
    const poisonId = uuidv7();
    const bogusRunId = uuidv7(); // no such native_runs row
    const now = Date.now();
    await publishIngest(fields(conversationId, agent.id, "good", { id: goodId, ts: now }));
    await publishIngest(fields(conversationId, agent.id, "poison", { id: poisonId, runId: bogusRunId, ts: now }));

    // Must not throw: the poison is quarantined inside persistIngestBatch.
    await drainIngestStream();

    const goodRows = await db.query.messages.findMany({ where: eq(messages.id, goodId) });
    expect(goodRows.length).toBe(1);
    const poisonRows = await db.query.messages.findMany({ where: eq(messages.id, poisonId) });
    expect(poisonRows.length).toBe(0);

    const poisonList = await redis.lrange("verse:ingest:poison", 0, -1);
    expect(poisonList.length).toBe(1);
    expect((JSON.parse(poisonList[0]) as { messageId: string }).messageId).toBe(poisonId);

    // The stream keeps moving: a later good entry persists normally.
    const laterId = uuidv7();
    await publishIngest(fields(conversationId, agent.id, "later", { id: laterId, ts: Date.now() }));
    await drainIngestStream();
    const laterRows = await db.query.messages.findMany({ where: eq(messages.id, laterId) });
    expect(laterRows.length).toBe(1);
  });
});
