import { describe, expect, it } from "vitest";
import type { PublicActivityItem } from "../../lib/api";
import { agentSpots, hue, layoutRooms, roomRadius, speakersFromMessages } from "./layout";

function group(partial: Partial<PublicActivityItem> & { conversation_id: string }): PublicActivityItem {
  return {
    last_message: "hello",
    last_sender_agent_id: "agent-1",
    last_message_at: new Date().toISOString(),
    agent_count: 3,
    message_count: 10,
    ...partial,
  };
}

describe("roomRadius", () => {
  it("grows with population and respects the cap", () => {
    expect(roomRadius(1)).toBeLessThan(roomRadius(25));
    expect(roomRadius(10000)).toBeLessThanOrEqual(7);
    expect(roomRadius(0)).toBeGreaterThan(0);
  });
});

describe("layoutRooms", () => {
  const groups = [
    group({ conversation_id: "c-small", agent_count: 2, message_count: 5 }),
    group({ conversation_id: "c-big", agent_count: 40, message_count: 900 }),
    group({ conversation_id: "c-mid", agent_count: 9, message_count: 120 }),
  ];

  it("puts the busiest room at the origin", () => {
    const rooms = layoutRooms(groups);
    expect(rooms[0].conversationId).toBe("c-big");
    expect(rooms[0].position).toEqual([0, 0, 0]);
  });

  it("rings the rest around the center without overlap distance collapsing", () => {
    const rooms = layoutRooms(groups);
    for (const r of rooms.slice(1)) {
      const d = Math.hypot(r.position[0], r.position[2]);
      expect(d).toBeGreaterThan(rooms[0].radius);
    }
  });

  it("is deterministic for the same input", () => {
    expect(layoutRooms(groups, 1700000000000)).toEqual(layoutRooms(groups, 1700000000000));
  });

  it("heat decays with message age", () => {
    const now = Date.now();
    const fresh = layoutRooms([group({ conversation_id: "a", last_message_at: new Date(now).toISOString() })], now);
    const stale = layoutRooms(
      [group({ conversation_id: "a", last_message_at: new Date(now - 6 * 3600_000).toISOString() })],
      now,
    );
    expect(fresh[0].heat).toBeGreaterThan(stale[0].heat);
  });
});

describe("agentSpots", () => {
  it("centers a lone agent and rings the rest inside the platform", () => {
    expect(agentSpots(1, 4)[0].dist).toBe(0);
    const spots = agentSpots(8, 4);
    expect(spots).toHaveLength(8);
    for (const s of spots) expect(s.dist).toBeLessThan(4);
  });
});

describe("speakersFromMessages", () => {
  const msgs = [
    { senderAgentId: "a", content: "first", createdAt: "2026-01-01T00:00:00Z" },
    { senderAgentId: "b", content: "second", createdAt: "2026-01-01T00:01:00Z" },
    { senderAgentId: "a", content: "third", createdAt: "2026-01-01T00:02:00Z" },
  ];

  it("dedupes by sender with the latest line winning, most recent first", () => {
    const speakers = speakersFromMessages(msgs);
    expect(speakers.map((s) => s.agentId)).toEqual(["a", "b"]);
    expect(speakers[0].lastLine).toBe("third");
  });

  it("respects the cap", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      senderAgentId: `agent-${i}`,
      content: `m${i}`,
    }));
    expect(speakersFromMessages(many, 12)).toHaveLength(12);
  });
});

describe("hue", () => {
  it("is stable and in range", () => {
    expect(hue("agent-1")).toBe(hue("agent-1"));
    expect(hue("agent-1")).toBeGreaterThanOrEqual(0);
    expect(hue("agent-1")).toBeLessThan(360);
  });
});
