import { describe, expect, test, beforeAll } from "bun:test";
import { createApp } from "../app";
import { ensureRoomsSeeded } from "../db/seed";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();

async function registerAgent(name: string) {
  const email = `room-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  const { agentToken } = await created.json();
  return agentToken as string;
}

beforeAll(async () => {
  await ensureRoomsSeeded();
});

describe("rooms route", () => {
  test("GET /rooms lists seeded rooms", async () => {
    const res = await app.request("/rooms");
    expect(res.status).toBe(200);
    const { rooms } = await res.json();
    expect(rooms.some((r: { slug: string }) => r.slug === "general")).toBe(true);
  });

  test("joining an unknown room slug returns 404", async () => {
    const token = await registerAgent("RoomAgent404");
    const res = await app.request("/rooms/does-not-exist/join", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  test("joining the same room twice is idempotent, not an error or duplicate row", async () => {
    await resetMemoryStoreForTests();
    const token = await registerAgent("RoomAgentIdempotent");

    const first = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.status).toBe(200);
    const { conversationId: firstId } = await first.json();

    const second = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.status).toBe(200);
    const { conversationId: secondId } = await second.json();

    expect(secondId).toBe(firstId);
  });

  test("agent at max simultaneous conversations cap is blocked from joining a new room", async () => {
    await resetMemoryStoreForTests();
    const token = await registerAgent("RoomAgentCapped");

    for (let i = 0; i < 20; i++) {
      const res = await app.request("/conversations", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ isPublic: false }),
      });
      expect(res.status).toBe(201);
    }

    const joinOverCap = await app.request("/rooms/science/join", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(joinOverCap.status).toBe(429);
  }, 15000);

  test("leaving a conversation frees its admission slot for a new join", async () => {
    await resetMemoryStoreForTests();
    const token = await registerAgent("RoomAgentLeaveRejoin");

    const created = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ isPublic: false }),
    });
    expect(created.status).toBe(201);
    const { conversation } = await created.json();

    for (let i = 0; i < 19; i++) {
      const res = await app.request("/conversations", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ isPublic: false }),
      });
      expect(res.status).toBe(201);
    }

    // at the cap now (20) — a 21st would 429
    const blocked = await app.request("/rooms/science/join", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blocked.status).toBe(429);

    const left = await app.request(`/conversations/${conversation.id}/leave`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(left.status).toBe(200);
    expect((await left.json()).left).toBe(true);

    // slot freed — the same join that was just blocked now succeeds
    const rejoin = await app.request("/rooms/science/join", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rejoin.status).toBe(200);

    // leaving again (not a participant anymore) is a no-op, not an error
    const leaveAgain = await app.request(`/conversations/${conversation.id}/leave`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(leaveAgain.status).toBe(200);
    expect((await leaveAgain.json()).left).toBe(false);
  }, 15000);
});
