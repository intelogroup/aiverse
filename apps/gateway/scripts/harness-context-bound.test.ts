import { describe, test, expect } from "bun:test";
import { boundModelContext, estimateTokens, CONTEXT_TOKEN_BUDGET } from "./harness-context-bound";

// Synthetic context shaped like the real one at tick 400 of a dense run:
// 250+ DM entries, a large roster, 20 public rows, 8 focused threads.
function oversizedContext() {
  const open_dm_by_participant: Record<string, string> = {};
  for (let i = 0; i < 250; i++) open_dm_by_participant[`agent-${i}`] = `conv-${i}`;
  const peers = Array.from({ length: 200 }, (_, i) => ({ agentId: `agent-${i}`, name: `Peer${i}`, status: "online" }));
  const public_activity = Array.from({ length: 20 }, (_, i) => ({ conversation_id: `pub-${i}`, content: "x".repeat(80) }));
  const conversations = Array.from({ length: 8 }, (_, i) => ({
    conversation_id: `conv-${i}`,
    unread: 1,
    messages: Array.from({ length: 4 }, (_, j) => ({ content: "y".repeat(400), sender_agent_id: `agent-${j}` })),
  }));
  return {
    manifest: { name: "EcoMPL-1", capabilities: ["code"] },
    peers,
    memory_notes: "n".repeat(3000),
    inbox_focus: conversations,
    inbox_summary: { total_threads: 250, other_threads_with_inbound: 10, awaiting_reply_from_me: 2 },
    conversations,
    public_activity,
    mentions_of_me: Array.from({ length: 5 }, (_, i) => ({ content: `m${i}`, conversation_id: `conv-${i}` })),
    arrivals: Array.from({ length: 10 }, (_, i) => ({ agent_id: `a${i}`, name: `A${i}` })),
    already_joined_rooms: ["general", "science", "robotics"],
    open_dm_by_participant,
    known_room_slugs: ["general", "science", "robotics"],
  };
}

describe("boundModelContext", () => {
  test("brings an oversized context under the token budget", () => {
    const ctx = oversizedContext();
    const before = estimateTokens(JSON.stringify(ctx));
    expect(before).toBeGreaterThan(CONTEXT_TOKEN_BUDGET);
    const { bounded, trims } = boundModelContext(ctx as any);
    const after = estimateTokens(JSON.stringify(bounded));
    expect(after).toBeLessThanOrEqual(CONTEXT_TOKEN_BUDGET);
    expect(trims.length).toBeGreaterThan(0);
    // the dedup must have fired — the duplicate focused-threads field is the
    // single largest waste in the real shape
    expect(trims).toContain("inbox_focus:deduped");
    expect(bounded.inbox_focus).toBeUndefined();
  });

  test("preserves the decision-critical ground-truth fields", () => {
    const { bounded } = boundModelContext(oversizedContext() as any) as any;
    expect(Array.isArray(bounded.known_room_slugs)).toBe(true);
    expect(bounded.known_room_slugs.length).toBe(3);
    expect(Array.isArray(bounded.already_joined_rooms)).toBe(true);
    // open_dm_by_participant is trimmed, never deleted
    expect(Object.keys(bounded.open_dm_by_participant).length).toBeGreaterThan(0);
    expect(Object.keys(bounded.open_dm_by_participant).length).toBeLessThanOrEqual(40);
    // mentions survive (capped at 3, the newest-first slice keeps the first)
    expect((bounded.mentions_of_me ?? []).length).toBeLessThanOrEqual(3);
  });

  test("does not mutate or trim an already-small context", () => {
    const small = { peers: [{ agentId: "a" }], known_room_slugs: ["general"], open_dm_by_participant: { a: "c1" } };
    const { bounded, trims } = boundModelContext({ ...small } as any);
    expect(trims).toEqual([]);
    expect(bounded).toEqual(small);
  });

  test("handles pathological content without throwing, under budget", () => {
    const pathological: any = {
      peers: Array.from({ length: 2000 }, (_, i) => ({ agentId: `p${i}`, blob: "z".repeat(50) })),
      public_activity: Array.from({ length: 500 }, (_, i) => ({ content: "q".repeat(200) })),
      known_room_slugs: ["general"],
    };
    const { bounded, trims } = boundModelContext(pathological);
    expect(trims.length).toBeGreaterThan(0);
    expect(bounded.known_room_slugs).toEqual(["general"]);
    expect(estimateTokens(JSON.stringify(bounded))).toBeLessThanOrEqual(CONTEXT_TOKEN_BUDGET);
  });

  test("drop fail-safes fire only when the caps alone cannot fit the budget", () => {
    // 40 capped peers still huge -> the peers:dropped fail-safe must fire
    const forced: any = {
      peers: Array.from({ length: 100 }, (_, i) => ({ agentId: `p${i}`, blob: "z".repeat(4000) })),
      known_room_slugs: ["general"],
    };
    const { bounded, trims } = boundModelContext(forced);
    expect(trims).toContain("peers:dropped");
    expect(estimateTokens(JSON.stringify(bounded))).toBeLessThanOrEqual(CONTEXT_TOKEN_BUDGET);
    expect(bounded.known_room_slugs).toEqual(["general"]);
  });
});