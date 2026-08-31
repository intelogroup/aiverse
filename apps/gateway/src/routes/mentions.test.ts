import { describe, expect, test, afterAll } from "bun:test";
import { createApp } from "../app";
import { ensureRoomsSeeded } from "../db/seed";
import { websocket } from "../ws/gateway";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

afterAll(() => {
  server.stop(true);
});

async function registerAgent(name: string) {
  const email = `mention-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

  // default wallet autonomy_mode is "observe" (blocks outbound sends) — the
  // mention tests exercise messaging, so promote to "autonomous" up front.
  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });

  return agentToken as string;
}

describe("@-mention pings", () => {
  test("a mention written in the wrong case still pings the named agent", async () => {
    await resetMemoryStoreForTests();
    await ensureRoomsSeeded();
    const [targetToken, senderToken] = await Promise.all([
      registerAgent("MentionTarget1"),
      registerAgent("MentionSender1"),
    ]);

    const wsTarget = new WebSocket(`ws://localhost:${server.port}/agents/ws?token=${targetToken}`);
    const mentioned = new Promise<any>((resolve) => {
      wsTarget.onmessage = (msg) => {
        const event = JSON.parse(String(msg.data));
        if (event.type === "mentioned") resolve(event);
      };
    });
    await new Promise((resolve) => (wsTarget.onopen = resolve));
    await new Promise<void>((resolve) => {
      const check = (msg: MessageEvent) => {
        if (JSON.parse(String(msg.data)).type === "agent_connected") resolve();
      };
      wsTarget.addEventListener("message", check);
    });

    const join = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${senderToken}` },
    });
    expect(join.status).toBe(200);
    const { conversationId } = await join.json();

    // Wrong case on purpose — resolution must be case-insensitive.
    const send = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${senderToken}` },
      body: JSON.stringify({ content: "@mentiontarget1 hello, are you there?" }),
    });
    expect(send.status).toBe(201);

    const event = await mentioned;
    expect(event.payload.room_slug).toBe("general");
    expect(event.payload.is_public).toBe(true);
    expect(event.payload.content).toContain("@mentiontarget1");
    wsTarget.close();
  }, 10000);

  test("mentioning a name that does not exist still delivers the message", async () => {
    await resetMemoryStoreForTests();
    await ensureRoomsSeeded();
    const token = await registerAgent("MentionSender2");

    const join = await app.request("/rooms/science/join", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(join.status).toBe(200);
    const { conversationId } = await join.json();

    const send = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "@NoSuchAgentHere anyone home?" }),
    });
    expect(send.status).toBe(201);
  }, 10000);
});
