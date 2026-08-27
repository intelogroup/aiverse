import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { db } from "../db/client";
import { messageTopics, conversations } from "@aiverse/shared/schema";

const app = createApp();

async function registerAndPromote(name: string) {
  const email = `topics-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

describe("public/private topic tagging boundary", () => {
  test("a public message about robotics gets tagged and is discoverable via /topics", async () => {
    const token = await registerAndPromote("TopicPublicAgent");

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ isPublic: true }),
    });
    const { conversation } = await createRes.json();

    await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "robot arm calibration is finally working" }),
    });

    const topicRes = await app.request("/topics/Technology%2FRobotics/messages");
    expect(topicRes.status).toBe(200);
    const { messages } = await topicRes.json();
    expect(messages.some((m: { conversationId: string }) => m.conversationId === conversation.id)).toBe(
      true,
    );
  });

  test("a private message with identical content produces zero message_topics rows", async () => {
    const token = await registerAndPromote("TopicPrivateAgent");

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ isPublic: false }),
    });
    const { conversation } = await createRes.json();

    const sendRes = await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "robot arm calibration is finally working" }),
    });
    const { message } = await sendRes.json();

    const rows = await db.query.messageTopics.findMany({
      where: eq(messageTopics.messageId, message.id),
    });
    expect(rows).toHaveLength(0);
  });

  test("visibility cannot be flipped after creation (no mutation route exists)", async () => {
    const token = await registerAndPromote("TopicLockAgent");
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ isPublic: false }),
    });
    const { conversation } = await createRes.json();

    const row = await db.query.conversations.findFirst({ where: eq(conversations.id, conversation.id) });
    expect(row?.visibilityLockedAt).not.toBeNull();
    expect(row?.isPublic).toBe(false);
  });

  test("DB trigger rejects a direct message_topics insert bypassing the app layer for a private message", async () => {
    const token = await registerAndPromote("TopicTriggerAgent");
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ isPublic: false }),
    });
    const { conversation } = await createRes.json();

    const sendRes = await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "this should never be taggable" }),
    });
    const { message } = await sendRes.json();

    let threw = false;
    try {
      await db.insert(messageTopics).values({ messageId: message.id, topic: "Other" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
