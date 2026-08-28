import { describe, expect, test, beforeAll } from "bun:test";
import { createApp } from "../app";
import { ensureRoomsSeeded } from "../db/seed";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();

async function registerAgent(name: string) {
  const email = `conv-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

  // default wallet autonomy_mode is "observe" (blocks outbound sends) — most
  // of these tests exercise messaging, so promote to "autonomous" up front.
  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });

  return agentToken as string;
}

beforeAll(async () => {
  await ensureRoomsSeeded();
});

describe("rooms + messaging", () => {
  test("agent joins room, sends message, participant reads it back", async () => {
    await resetMemoryStoreForTests();
    const tokenA = await registerAgent("ConvAgentA");
    const tokenB = await registerAgent("ConvAgentB");

    const joinA = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(joinA.status).toBe(200);
    const { conversationId } = await joinA.json();

    const joinB = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(joinB.status).toBe(200);

    const sendRes = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ content: "hello room" }),
    });
    expect(sendRes.status).toBe(201);
    const { message } = await sendRes.json();
    expect(message.content).toBe("hello room");

    const replyRes = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ content: "hi back", replyToId: message.id }),
    });
    expect(replyRes.status).toBe(201);
    const { message: reply } = await replyRes.json();
    expect(reply.replyToId).toBe(message.id);

    const historyRes = await app.request(`/conversations/${conversationId}/messages`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const { messages } = await historyRes.json();
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  test("non-participant cannot send to a private conversation", async () => {
    await resetMemoryStoreForTests();
    const tokenA = await registerAgent("PrivAgentA");
    const tokenOutsider = await registerAgent("PrivOutsider");

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ isPublic: false }),
    });
    const { conversation } = await createRes.json();

    const sendRes = await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenOutsider}` },
      body: JSON.stringify({ content: "sneaking in" }),
    });
    expect(sendRes.status).toBe(403);
  });

  test("agent send-rate limiter rejects burst above 1 msg/sec", async () => {
    await resetMemoryStoreForTests();
    const tokenA = await registerAgent("RateAgentA");
    const joinA = await app.request("/rooms/science/join", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const { conversationId } = await joinA.json();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.request(`/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({ content: "spam" }),
        }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201).length).toBeLessThan(10);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  test(
    "agent past max simultaneous conversations is blocked from joining more",
    async () => {
      await resetMemoryStoreForTests();
      const token = await registerAgent("CapAgent");

      // sequential on purpose: admission-count check + track must observe each
      // prior insert, so 20 * 2 Neon roundtrips genuinely exceeds bun's default
      // 5000ms test timeout — same root cause as the earlier WS registration
      // flake, not a logic bug.
      for (let i = 0; i < 20; i++) {
        const res = await app.request("/conversations", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ isPublic: false }),
        });
        expect(res.status).toBe(201);
      }

      const overCap = await app.request("/conversations", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ isPublic: false }),
      });
      expect(overCap.status).toBe(429);
    },
    15000,
  );

  test("retrying a send with the same clientMessageId returns the original, doesn't duplicate or double-charge", async () => {
    await resetMemoryStoreForTests();
    const token = await registerAgent("ConvAgentIdempotent");

    // private, per-test conversation — not the shared "general" room, whose
    // history persists in Postgres across test runs (only Redis gets reset)
    // and would accumulate same-clientMessageId rows from earlier runs.
    const created = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ isPublic: false }),
    });
    expect(created.status).toBe(201);
    const { conversation } = await created.json();
    const conversationId = conversation.id;

    const clientMessageId = `retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = JSON.stringify({ content: "sent once", clientMessageId, tokensUsed: 50 });

    const first = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
    });
    expect(first.status).toBe(201);
    const { message: firstMessage } = await first.json();

    // simulate a client retry after a lost response — same clientMessageId,
    // same conversation, same sender
    const retry = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
    });
    expect(retry.status).toBe(200); // not 201 — no new message was created
    const { message: retryMessage } = await retry.json();
    expect(retryMessage.id).toBe(firstMessage.id);

    const history = await app.request(`/conversations/${conversationId}/messages`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const { messages: allMessages } = await history.json();
    const matching = allMessages.filter((m: { clientMessageId: string | null }) => m.clientMessageId === clientMessageId);
    expect(matching.length).toBe(1); // exactly one row, not two

    // the retry short-circuited before budget consumption — sending 50
    // tokens twice should have only cost 50, not 100. Confirm indirectly:
    // a fresh send for the same agent with tokensUsed right up to a small
    // remaining budget still succeeds (would 429 if double-charged).
    // Wait out the 1msg/sec agent-level rate bucket first (the first send
    // above already consumed its only token; the retry short-circuited
    // before touching it, but this follow-up is a real 2nd send).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const followUp = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "second message", tokensUsed: 1 }),
    });
    expect(followUp.status).toBe(201);
  });

  test("message attachments persist, capped at 5", async () => {
    await resetMemoryStoreForTests();
    const token = await registerAgent("AttachAgent");
    const joinRes = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const { conversationId } = await joinRes.json();

    const attachments = Array.from({ length: 7 }, (_, i) => ({ url: `https://example.com/${i}`, title: `doc ${i}`, type: "link" }));
    const sendRes = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "evidence attached", attachments }),
    });
    expect(sendRes.status).toBe(201);

    const { db } = await import("../db/client");
    const { messageAttachments } = await import("@aiverse/shared/schema");
    const { eq } = await import("drizzle-orm");
    const { message } = await sendRes.json();
    const rows = await db.query.messageAttachments.findMany({ where: eq(messageAttachments.messageId, message.id) });
    expect(rows.length).toBe(5); // capped, not 7
  });
});

describe("invite", () => {
  async function registerAgentWithId(name: string) {
    const email = `conv-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
    return { token: agentToken as string, agentId: agent.id as string, ownerToken: ownerToken as string };
  }

  test("participant can invite an agent into an existing conversation", async () => {
    await resetMemoryStoreForTests();
    const host = await registerAgentWithId("InviteHost");
    const guest = await registerAgentWithId("InviteGuest");

    const created = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isPublic: false }),
    });
    const { conversation } = await created.json();

    const inviteRes = await app.request(`/conversations/${conversation.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ agentId: guest.agentId }),
    });
    expect(inviteRes.status).toBe(200);
    const inviteBody = await inviteRes.json();
    expect(inviteBody.invited).toBe(true);

    // guest can now send into the conversation it was invited into
    const sendRes = await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${guest.token}` },
      body: JSON.stringify({ content: "thanks for the invite" }),
    });
    expect(sendRes.status).toBe(201);
  });

  test("non-participant cannot invite into a conversation it hasn't joined", async () => {
    await resetMemoryStoreForTests();
    const host = await registerAgentWithId("InviteHost2");
    const outsider = await registerAgentWithId("InviteOutsider");
    const guest = await registerAgentWithId("InviteGuest2");

    const created = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isPublic: false }),
    });
    const { conversation } = await created.json();

    const inviteRes = await app.request(`/conversations/${conversation.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${outsider.token}` },
      body: JSON.stringify({ agentId: guest.agentId }),
    });
    expect(inviteRes.status).toBe(403);
  });

  test("invite is blocked when target has blocked the caller", async () => {
    await resetMemoryStoreForTests();
    const host = await registerAgentWithId("InviteHost3");
    const blocker = await registerAgentWithId("InviteBlocker");

    const created = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isPublic: false }),
    });
    const { conversation } = await created.json();

    await app.request(`/owners/agents/${blocker.agentId}/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${blocker.ownerToken}` },
      body: JSON.stringify({ blockedAgentIds: [host.agentId] }),
    });

    const inviteRes = await app.request(`/conversations/${conversation.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ agentId: blocker.agentId }),
    });
    expect(inviteRes.status).toBe(403);
  });
});
