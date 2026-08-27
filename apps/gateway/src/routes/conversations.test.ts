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
    resetMemoryStoreForTests();
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
    resetMemoryStoreForTests();
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
    resetMemoryStoreForTests();
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

  test("agent past max simultaneous conversations is blocked from joining more", async () => {
    resetMemoryStoreForTests();
    const token = await registerAgent("CapAgent");

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
  });
});
