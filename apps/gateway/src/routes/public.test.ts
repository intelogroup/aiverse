import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { setPublicCacheTtlForTests, cacheStats } from "../util/publicCache";
import { db } from "../db/client";
import { messages as messagesTable } from "@aiverse/shared/schema";

const app = createApp();

async function registerAndPromote(name: string) {
  const email = `pub-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  return agentToken as string;
}

describe("public trending + search", () => {
  test("trending counts a freshly seeded public robotics message", async () => {
    await resetMemoryStoreForTests();
    const token = await registerAndPromote("PublicTrendAgent");
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ isPublic: true, name: "trending-test-discussion" }),
    });
    const { conversation } = await createRes.json();
    await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "robot arm calibration breakthrough today" }),
    });

    const res = await app.request("/public/trending?window=24h");
    expect(res.status).toBe(200);
    const { topics } = await res.json();
    const robotics = topics.find((t: { topic: string }) => t.topic === "Technology/Robotics");
    expect(robotics).toBeDefined();
    expect(Number(robotics.messageCount)).toBeGreaterThan(0);
  });

  test("search returns a structured digest, not a raw dump, with correct thread grouping", async () => {
    await resetMemoryStoreForTests();
    const token = await registerAndPromote("PublicSearchAgent");
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ isPublic: true, name: "search-test-discussion" }),
    });
    const { conversation } = await createRes.json();
    await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "USPS delivery delays are getting worse in Boston" }),
    });

    const res = await app.request("/public/search?q=USPS+delivery");
    expect(res.status).toBe(200);
    const digest = await res.json();
    expect(digest).toHaveProperty("conversation_count");
    expect(digest).toHaveProperty("agent_count");
    expect(digest).toHaveProperty("threads");
    expect(Array.isArray(digest.threads)).toBe(true);
    expect(digest.threads.some((t: { conversation_id: string }) => t.conversation_id === conversation.id)).toBe(
      true,
    );
    // structured digest, not a transcript: no raw "messages" array leaking through
    expect(digest.messages).toBeUndefined();
  });

  test("private conversations never appear in trending or search", async () => {
    await resetMemoryStoreForTests();
    const token = await registerAndPromote("PublicPrivacyAgent");
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ isPublic: false, name: "privacy-test-discussion" }),
    });
    const { conversation } = await createRes.json();
    await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "this secret robot arm calibration must stay private" }),
    });

    const searchRes = await app.request("/public/search?q=secret+robot+arm+calibration");
    const digest = await searchRes.json();
    expect(digest.threads.some((t: { conversation_id: string }) => t.conversation_id === conversation.id)).toBe(
      false,
    );

    const rawRes = await app.request(`/public/conversations/${conversation.id}`);
    expect(rawRes.status).toBe(404);
  });
});

describe("public feed egress controls (pagination + TTL cache)", () => {
  // Deterministic timestamps via direct insert — HTTP-posted messages can
  // share a millisecond, which would make the before-cursor test flaky.
  async function seedThread(conversationId: string, senderAgentId: string, count: number) {
    const base = Date.now() - count * 10_000;
    await db.insert(messagesTable).values(
      Array.from({ length: count }, (_, i) => ({
        conversationId,
        senderAgentId,
        content: `paging message number ${i + 1}`,
        createdAt: new Date(base + i * 10_000),
      })),
    );
  }

  // registerAndPromote only returns the token; these tests also need the
  // agent UUID (sender for direct message inserts), so a local variant.
  async function registerPromoteWithAgent(name: string): Promise<{ token: string; agentId: string }> {
    const email = `pubp-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
    return { token: agentToken as string, agentId: agent.id as string };
  }

  test("conversations/:id returns only the latest N messages, ascending, with has_more + next_before", async () => {
    await resetMemoryStoreForTests();
    const { token, agentId } = await registerPromoteWithAgent("PublicPagingAgent");
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ isPublic: true, name: "paging-test-discussion" }),
    });
    const { conversation } = await createRes.json();
    await seedThread(conversation.id, agentId, 7);

    const res = await app.request(`/public/conversations/${conversation.id}?limit=4`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // latest 4 of 7, ascending render order
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual([
      "paging message number 4",
      "paging message number 5",
      "paging message number 6",
      "paging message number 7",
    ]);
    expect(body.has_more).toBe(true);
    expect(body.next_before).toBeTruthy();

    // back-fill page: strictly older than next_before → messages 1-3, no more
    const res2 = await app.request(`/public/conversations/${conversation.id}?limit=4&before=${body.next_before}`);
    const body2 = await res2.json();
    expect(body2.messages.map((m: { content: string }) => m.content)).toEqual([
      "paging message number 1",
      "paging message number 2",
      "paging message number 3",
    ]);
    expect(body2.has_more).toBe(false);
  });

  test("the entire thread is no longer returned: default cap applies", async () => {
    await resetMemoryStoreForTests();
    const { token, agentId } = await registerPromoteWithAgent("PublicPagingAgent2");
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ isPublic: true, name: "paging-cap-discussion" }),
    });
    const { conversation } = await createRes.json();
    await seedThread(conversation.id, agentId, 150);

    const res = await app.request(`/public/conversations/${conversation.id}`);
    const body = await res.json();
    expect(body.messages.length).toBe(100); // default limit, not 150
    expect(body.has_more).toBe(true);
  });

  test("activity message_count uses the denormalized column maintained by the insert path (0034)", async () => {
    await resetMemoryStoreForTests();
    const token = await registerAndPromote("PublicCountAgent");
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ isPublic: true, name: "message-count-discussion" }),
    });
    const { conversation } = await createRes.json();
    // three real sends through the production insert path (bucket reset
    // between sends — burst-1 per-agent message bucket)
    for (let i = 0; i < 3; i++) {
      if (i > 0) await resetMemoryStoreForTests();
      const post = await app.request(`/conversations/${conversation.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: `count me ${i}` }),
      });
      expect(post.status).toBe(201);
    }

    const res = await app.request("/public/activity");
    expect(res.status).toBe(200);
    const { activity } = await res.json();
    const row = (activity as Array<{ conversation_id: string; message_count: number }>).find(
      (a) => a.conversation_id === conversation.id,
    );
    expect(row).toBeDefined();
    expect(row!.message_count).toBe(3);
  });

  test("duplicate polls within the TTL hit the cache, not the DB (Neon egress dedupe)", async () => {
    await resetMemoryStoreForTests();
    setPublicCacheTtlForTests(2_000);
    const hitsBefore = cacheStats.hits;
    const missesBefore = cacheStats.misses;

    await app.request("/public/activity");
    await app.request("/public/activity");
    expect(cacheStats.misses).toBe(missesBefore + 1); // one DB read...
    expect(cacheStats.hits).toBe(hitsBefore + 1); // ...served the second poll

    // restore test-mode no-cache so the rest of the suite always sees fresh state
    setPublicCacheTtlForTests(0);
  });
});
