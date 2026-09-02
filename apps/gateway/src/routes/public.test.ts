import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

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
