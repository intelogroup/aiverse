import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { db } from "../db/client";
import { messageTopics, conversations } from "@aiverse/shared/schema";
import { drainIngestStream } from "../jobs/ingestConsumer"; // item 1: async persist, drain before row assertions

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
      body: JSON.stringify({ isPublic: true, name: "topics-public-test" }),
    });
    const { conversation } = await createRes.json();

    await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "robot arm calibration is finally working" }),
    });

    await drainIngestStream(); // async persist (item 1): tagging happens in the consumer
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
      body: JSON.stringify({ isPublic: false, name: "topics-private-test" }),
    });
    const { conversation } = await createRes.json();

    const sendRes = await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "robot arm calibration is finally working" }),
    });
    const { message } = await sendRes.json();

    await drainIngestStream(); // async persist (item 1): tagging happens in the consumer
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
      body: JSON.stringify({ isPublic: false, name: "topics-lock-test" }),
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
      body: JSON.stringify({ isPublic: false, name: "topics-trigger-test" }),
    });
    const { conversation } = await createRes.json();

    const sendRes = await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "this should never be taggable" }),
    });
    const { message } = await sendRes.json();

    // Async persist (item 1): the message row must EXIST before the trigger
    // is what's tested — without the drain the FK violation would pass this
    // test for the wrong reason.
    await drainIngestStream();
    let threw = false;
    try {
      await db.insert(messageTopics).values({ messageId: message.id, topic: "Other" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// AIV-TOPICS-PAGINATION-001: the public topics read passed limit/offset
// through Number() with no validation — GET ?offset=-1 returned an
// unhandled 500 in production (2026-11-09 security audit, M1). Invalid
// pagination is now a clean 400; valid values clamp to the route's range.
describe("topics pagination hardening (AIV-TOPICS-PAGINATION-001)", () => {
  test("negative offset is a 400, not a 500", async () => {
    const res = await app.request("/topics/securityprobe/messages?offset=-1");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_pagination");
  });

  test("non-numeric and fractional pagination values are 400s", async () => {
    for (const q of ["offset=abc", "offset=1.5", "limit=abc", "limit=2.5", "limit=0", "limit=-3"]) {
      const res = await app.request(`/topics/securityprobe/messages?${q}`);
      expect(res.status).toBe(400);
    }
  });

  test("valid pagination still reads, and an oversized limit clamps instead of erroring", async () => {
    const plain = await app.request("/topics/securityprobe/messages");
    expect(plain.status).toBe(200);
    const plainBody = await plain.json();
    expect(plainBody.topic).toBe("securityprobe");
    expect(Array.isArray(plainBody.messages)).toBe(true);

    const clamped = await app.request("/topics/securityprobe/messages?limit=9999&offset=0");
    expect(clamped.status).toBe(200);
  });
});
