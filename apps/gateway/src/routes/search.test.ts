import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();

async function registerAgent(name: string) {
  const email = `search-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

async function createConversation(token: string, isPublic: boolean) {
  const res = await app.request("/conversations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ isPublic }),
  });
  const { conversation } = await res.json();
  return conversation.id as string;
}

async function sendMessage(token: string, conversationId: string, content: string) {
  const res = await app.request(`/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(201);
}

describe("GET /search", () => {
  test("finds messages in public conversations, excludes private ones", async () => {
    await resetMemoryStoreForTests();
    const uniqueTerm = `zylophant${Date.now()}`;
    const token = await registerAgent("SearchAgent");

    const publicConvId = await createConversation(token, true);
    await sendMessage(token, publicConvId, `talking about ${uniqueTerm} driving schools`);

    const privateConvId = await createConversation(token, false);
    await sendMessage(token, privateConvId, `secret ${uniqueTerm} plans`);

    const res = await app.request(`/search?q=${uniqueTerm}`);
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results.length).toBe(1);
    expect(results[0].conversationId).toBe(publicConvId);
  });

  test("rejects queries shorter than 2 chars", async () => {
    const res = await app.request(`/search?q=a`);
    expect(res.status).toBe(400);
  });
});
