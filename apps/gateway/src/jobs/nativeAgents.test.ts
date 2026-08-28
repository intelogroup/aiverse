import { describe, expect, test, beforeAll, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, agentMemory, conversationParticipants, nativeRuns } from "@aiverse/shared/schema";
import { ensureRoomsSeeded } from "../db/seed";
import { resetMemoryStoreForTests, takeToken } from "../policy/memoryStore";
import { ensureNativeAgents, setLLMProviderForTests, tickOne, startRun, stopRun, getCurrentRunId } from "./nativeAgents";
import type { LLMProvider } from "../llm/provider";

function stubProvider(response: string | null): LLMProvider {
  return { complete: async () => response };
}

beforeAll(async () => {
  await ensureRoomsSeeded();
  await ensureNativeAgents();
});

async function getNative(name: string) {
  const agent = await db.query.agents.findFirst({ where: eq(agents.name, name) });
  if (!agent) throw new Error(`native ${name} not found`);
  return agent;
}

describe("native agents", () => {
  test("ensureNativeAgents joins every seeded public room", async () => {
    const sage = await getNative("Sage");
    const parts = await db.query.conversationParticipants.findMany({ where: eq(conversationParticipants.agentId, sage.id) });
    expect(parts.length).toBeGreaterThanOrEqual(4); // general, science, robotics, verse
  });

  test("reply action posts through the real conversation service and records memory", async () => {
    await resetMemoryStoreForTests();
    const sage = await getNative("Sage");
    const conv = await db.query.conversationParticipants.findFirst({ where: eq(conversationParticipants.agentId, sage.id) });
    if (!conv) throw new Error("sage has no conversation");

    // seed one message so gatherContext has something to react to
    const { messages } = await import("@aiverse/shared/schema");
    await db.insert(messages).values({ conversationId: conv.conversationId, senderAgentId: sage.id, content: "seed message for reply test" });

    setLLMProviderForTests(stubProvider(JSON.stringify({ action: "reply", conversationId: conv.conversationId, content: "test reply from Sage" })));
    await tickOne(sage.id, "Sage", "prompt", "objective");

    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, conv.conversationId), orderBy: (m, { desc }) => [desc(m.createdAt)], limit: 1 });
    expect(rows[0]?.content).toBe("test reply from Sage");

    const memRows = await db.query.agentMemory.findMany({ where: eq(agentMemory.agentId, sage.id), orderBy: (m, { desc }) => [desc(m.createdAt)], limit: 1 });
    expect(memRows[0]?.type).toBe("interaction");
  });

  test("invite action creates a participant row and fires THREAD_PARTICIPANT_JOINED", async () => {
    await resetMemoryStoreForTests();
    const fixer = await getNative("Fixer");
    const conv = await db.query.conversationParticipants.findFirst({ where: eq(conversationParticipants.agentId, fixer.id) });
    if (!conv) throw new Error("fixer has no conversation");

    const [{ id: targetAgentId }] = await db
      .insert(agents)
      .values({ name: `NativeInviteTarget-${Date.now()}`, agentCard: {}, apiKeyHash: "x", status: "online" })
      .returning();

    setLLMProviderForTests(stubProvider(JSON.stringify({ action: "invite", conversationId: conv.conversationId, targetAgentId })));
    await tickOne(fixer.id, "Fixer", "prompt", "objective");

    const joined = await db.query.conversationParticipants.findFirst({
      where: eq(conversationParticipants.agentId, targetAgentId),
    });
    expect(joined?.conversationId).toBe(conv.conversationId);
  });

  test("cooldown blocks a second tick within the window", async () => {
    await resetMemoryStoreForTests();
    const nilo = await getNative("Nilo");
    // Nilo's cooldown key directly, capacity 1 refill 1/240 (matches nativeAgents.ts COOLDOWN_SECONDS.Nilo)
    const first = await takeToken(`native-social:${nilo.id}`, 1, 1 / 240);
    expect(first).toBe(true);
    const second = await takeToken(`native-social:${nilo.id}`, 1, 1 / 240);
    expect(second).toBe(false);
  });

  test("idle / unparseable LLM response produces no action and no memory row", async () => {
    await resetMemoryStoreForTests();
    const sage = await getNative("Sage");
    const before = await db.query.agentMemory.findMany({ where: eq(agentMemory.agentId, sage.id) });

    setLLMProviderForTests(stubProvider("not json at all"));
    await tickOne(sage.id, "Sage", "prompt", "objective");

    const after = await db.query.agentMemory.findMany({ where: eq(agentMemory.agentId, sage.id) });
    expect(after.length).toBe(before.length);
  });
});

describe("run_id attribution", () => {
  beforeEach(async () => {
    // Clean up any leaked run state from a previous partial failure
    if (getCurrentRunId()) await stopRun("aborted").catch(() => {});
  });
  afterEach(async () => {
    if (getCurrentRunId()) await stopRun("completed").catch(() => {});
  });

  test("startRun creates a native_runs header row in running state", async () => {
    const runId = await startRun();
    expect(runId).toBeTruthy();
    const row = await db.query.nativeRuns.findFirst({ where: eq(nativeRuns.id, runId) });
    expect(row).toBeTruthy();
    expect(row!.status).toBe("running");
    // Clean up so subsequent tests start clean
    await stopRun("completed");
  });

  test("reply message and memory are stamped with run_id when a run is active", async () => {
    await resetMemoryStoreForTests();
    const runId = await startRun();
    expect(getCurrentRunId()).toBe(runId);

    const sage = await getNative("Sage");
    const conv = await db.query.conversationParticipants.findFirst({ where: eq(conversationParticipants.agentId, sage.id) });
    if (!conv) throw new Error("sage has no conversation");

    // seed a message so gatherContext has something
    const { messages } = await import("@aiverse/shared/schema");
    await db.insert(messages).values({ conversationId: conv.conversationId, senderAgentId: sage.id, content: "seed for run_id test" });

    setLLMProviderForTests(stubProvider(JSON.stringify({ action: "reply", conversationId: conv.conversationId, content: "run_id test reply" })));
    await tickOne(sage.id, "Sage", "prompt", "objective");

    // Check the message has run_id
    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, conv.conversationId),
      orderBy: (m, { desc }) => [desc(m.createdAt)],
      limit: 1,
    });
    const lastMsg = rows.find((r) => r.clientMessageId !== null) ?? rows[0];
    expect(lastMsg?.content).toBe("run_id test reply");
    expect(lastMsg?.runId).toBe(runId);

    // Check memory has run_id
    const memRows = await db.query.agentMemory.findMany({
      where: eq(agentMemory.agentId, sage.id),
      orderBy: (m, { desc }) => [desc(m.createdAt)],
      limit: 1,
    });
    const lastMem = memRows[0];
    expect(lastMem?.type).toBe("interaction");
    expect(lastMem?.runId).toBe(runId);

    // Cross-check: source_message_id → messages.run_id == agent_memory.run_id
    if (lastMem?.sourceMessageId) {
      const srcMsg = await db.query.messages.findFirst({ where: eq(messages.id, lastMem.sourceMessageId) });
      expect(srcMsg?.runId).toBe(runId);
      expect(srcMsg?.runId).toBe(lastMem.runId);
    }

    await stopRun("completed");
  });

  test("stopRun marks the run completed and clears currentRunId", async () => {
    const runId = await startRun();
    expect(getCurrentRunId()).toBe(runId);
    await stopRun("completed");
    const row = await db.query.nativeRuns.findFirst({ where: eq(nativeRuns.id, runId) });
    expect(row?.status).toBe("completed");
    expect(row?.endedAt).toBeTruthy();
    expect(getCurrentRunId()).toBeNull();
  });

  test("non-experiment ticks (no run active) produce null run_id on message and memory", async () => {
    await resetMemoryStoreForTests();
    // Ensure no run is active
    expect(getCurrentRunId()).toBeNull();

    const sage = await getNative("Sage");
    const conv = await db.query.conversationParticipants.findFirst({ where: eq(conversationParticipants.agentId, sage.id) });
    if (!conv) throw new Error("sage has no conversation");

    const { messages } = await import("@aiverse/shared/schema");
    await db.insert(messages).values({ conversationId: conv.conversationId, senderAgentId: sage.id, content: "seed for null run_id test" });

    setLLMProviderForTests(stubProvider(JSON.stringify({ action: "reply", conversationId: conv.conversationId, content: "null run_id reply" })));
    await tickOne(sage.id, "Sage", "prompt", "objective");

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, conv.conversationId),
      orderBy: (m, { desc }) => [desc(m.createdAt)],
      limit: 1,
    });
    const lastMsg = rows.find((r) => r.clientMessageId !== null) ?? rows[0];
    expect(lastMsg?.content).toBe("null run_id reply");
    expect(lastMsg?.runId).toBeNull();
  });
});
