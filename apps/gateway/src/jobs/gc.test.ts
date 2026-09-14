import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, conversations, messages, agentMemory, goals, owners } from "@aiverse/shared/schema";
import { batchedDelete } from "./gc";

// Batched retention deletes (2026-09-07): the old unbounded DELETE would
// become one giant transaction at millions of rows. This proves the batching
// loop exhausts correctly across multiple sub-batch-size passes.
describe("gc batchedDelete", () => {
  test("deletes across multiple batches, loops to exhaustion, leaves newer rows alone", async () => {
    const [agent] = await db
      .insert(agents)
      .values({ name: `gc-test-agent-${Date.now()}`, agentCard: {}, apiKeyHash: `gchash-${Date.now()}-${Math.random()}`, status: "offline" })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ kind: "dm", isPublic: false, createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) })
      .returning();

    // 12 expired messages (older than 90d) + 2 fresh ones
    const oldTs = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await db.insert(messages).values(
      Array.from({ length: 12 }, (_, i) => ({
        conversationId: conv.id,
        senderAgentId: agent.id,
        content: `gc expired message ${i}`,
        createdAt: oldTs,
      })),
    );
    await db.insert(messages).values({
      conversationId: conv.id,
      senderAgentId: agent.id,
      content: "gc fresh message",
      createdAt: new Date(),
    });

    // batchSize 5 → 12 old rows must take 3 batches (5 + 5 + 2)
    const deleted = await batchedDelete("messages", "90 days", 5, 20);
    expect(deleted).toBe(12);

    // only the expired rows went; the fresh one survives
    const mine = await db.query.messages.findMany({
      where: eq(messages.conversationId, conv.id),
    });
    expect(mine.length).toBe(1);
    expect(mine[0].content).toBe("gc fresh message");

    // 0034: the denormalized conversations.message_count was recounted by
    // the delete batch — 13 seeded, 12 expired deleted → 1 remains
    const after = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) });
    expect(after!.messageCount).toBe(1);

    // second run is a no-op (exhausted)
    expect(await batchedDelete("messages", "90 days", 5, 20)).toBe(0);
  });

  test("whereExtra keeps goal-scoped agent_memory rows past the age cutoff", async () => {
    const [agent] = await db
      .insert(agents)
      .values({ name: `gc-mem-agent-${Date.now()}`, agentCard: {}, apiKeyHash: `gchash-mem-${Date.now()}-${Math.random()}`, status: "offline" })
      .returning();
    const [owner] = await db
      .insert(owners)
      .values({ email: `gc-mem-${Date.now()}@example.com`, passwordHash: "x" })
      .returning();
    const [goal] = await db
      .insert(goals)
      .values({ ownerId: owner.id, agentId: agent.id, objective: "gc test goal" })
      .returning();

    const oldTs = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await db.insert(agentMemory).values([
      { agentId: agent.id, type: "interaction", content: "old plain memory", createdAt: oldTs },
      { agentId: agent.id, type: "interaction", content: "old goal memory", goalId: goal.id, createdAt: oldTs },
    ]);

    const deleted = await batchedDelete("agent_memory", "90 days", 5000, 20, "goal_id IS NULL");
    expect(deleted).toBe(1);

    const remaining = await db.query.agentMemory.findMany({ where: eq(agentMemory.agentId, agent.id) });
    expect(remaining.length).toBe(1);
    expect(remaining[0].content).toBe("old goal memory");
  });
});
