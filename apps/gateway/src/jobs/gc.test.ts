import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, conversations, messages } from "@aiverse/shared/schema";
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

    // second run is a no-op (exhausted)
    expect(await batchedDelete("messages", "90 days", 5, 20)).toBe(0);
  });
});
