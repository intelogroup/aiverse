import { describe, expect, test, beforeAll, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, agentMemory, agentWallets, conversationParticipants, nativeRuns, conversations, messages } from "@aiverse/shared/schema";
import { ensureRoomsSeeded } from "../db/seed";
import { resetMemoryStoreForTests, takeToken } from "../policy/memoryStore";
import { ensureNativeAgents, setLLMProviderForTests, tickOne, startRun, stopRun, getCurrentRunId } from "./nativeAgents";
import type { LLMProvider } from "../llm/provider";

function stubProvider(response: string | null): LLMProvider {
  return { complete: async () => (response == null ? null : { content: response, tokensUsed: 0 }) };
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

  test("tick context carries onlineAgentCapabilities so Matchmaker can broker on real skills, not just names", async () => {
    await resetMemoryStoreForTests();
    const sage = await getNative("Sage");
    await db
      .insert(agents)
      .values({
        name: `CapabilityPeer-${Date.now()}`,
        agentCard: { capabilities: ["translation", "legal-research"] },
        apiKeyHash: "x",
        status: "online",
      })
      .returning();

    let capturedUserContent = "";
    setLLMProviderForTests({
      complete: async ({ messages }) => {
        capturedUserContent = messages[0]?.content ?? "";
        return { content: JSON.stringify({ action: "idle" }), tokensUsed: 0 };
      },
    });
    await tickOne(sage.id, "Sage", "prompt", "objective");

    const parsed = JSON.parse(capturedUserContent);
    expect(parsed.onlineAgentCapabilities).toBeDefined();
    const entry = Object.entries(parsed.onlineAgentCapabilities as Record<string, string[]>).find(([, caps]) =>
      caps.includes("legal-research"),
    );
    expect(entry).toBeDefined();
    expect(entry?.[1]).toEqual(["translation", "legal-research"]);
  });

  test("Kronikler (Chronicler) sees its own private DMs — gatherDMContext isn't Connector-only", async () => {
    // The gatherDMContext fix (2026-09-02) was written to cover every native
    // via the shared tickOne() call site, and its own comment claims Kronikler
    // gets it "for free" alongside Konekta/Connector — but that claim was
    // never independently re-verified for Kronikler specifically. Confirm it
    // here rather than trusting the comment.
    await resetMemoryStoreForTests();
    const kronikler = await getNative("Kronikler");

    const [peer] = await db
      .insert(agents)
      .values({ name: `DMPeerForKronikler-${Date.now()}`, agentCard: {}, apiKeyHash: "x", status: "online" })
      .returning();
    const [conv] = await db.insert(conversations).values({ kind: "dm", isPublic: false }).returning();
    await db.insert(conversationParticipants).values([
      { conversationId: conv.id, agentId: kronikler.id },
      { conversationId: conv.id, agentId: peer.id },
    ]);
    await db.insert(messages).values({ conversationId: conv.id, senderAgentId: peer.id, content: "unanswered DM for the chronicler to see" });

    let capturedUserContent = "";
    setLLMProviderForTests({
      complete: async ({ messages: msgs }) => {
        capturedUserContent = msgs[0]?.content ?? "";
        return { content: JSON.stringify({ action: "idle" }), tokensUsed: 0 };
      },
    });
    await tickOne(kronikler.id, "Kronikler", "prompt", "objective");

    const parsed = JSON.parse(capturedUserContent);
    const dm = (parsed.directMessages as any[]).find((d) => d.conversationId === conv.id);
    expect(dm).toBeDefined();
    expect(dm.awaitingMyReply).toBe(true);
    expect(dm.recentMessages.some((m: any) => m.content === "unanswered DM for the chronicler to see")).toBe(true);
  });

  test("a native's real LLM token cost is actually charged against its wallet", async () => {
    // Before this fix, every dispatch path passed a hardcoded tokensUsed: 0
    // to checkAndConsumeBudget no matter what the provider actually reported
    // — MAX_DAILY_TOKEN_BUDGET existed on the wallet but governed nothing.
    // Confirm the real number now lands in the Redis-backed daily counter.
    await resetMemoryStoreForTests();
    const sage = await getNative("Sage");
    const conv = await db.query.conversationParticipants.findFirst({ where: eq(conversationParticipants.agentId, sage.id) });
    if (!conv) throw new Error("sage has no conversation");

    setLLMProviderForTests({
      complete: async () => ({
        content: JSON.stringify({ action: "reply", conversationId: conv.conversationId, content: "billed reply" }),
        tokensUsed: 777,
      }),
    });
    await tickOne(sage.id, "Sage", "prompt", "objective");

    const { checkAndConsumeBudget, refundBudget } = await import("../policy/gate");
    // Consuming 0 more just reads back today's running total without
    // perturbing it further; refund immediately after so this probe
    // itself doesn't count as spend.
    const probe = await checkAndConsumeBudget(sage.id, 0, 999_999);
    expect(probe.tokensUsedToday).toBeGreaterThanOrEqual(777);
  });

  test("a native at its daily budget cap does not act on the next tick", async () => {
    await resetMemoryStoreForTests();
    const fixer = await getNative("Fixer");
    const conv = await db.query.conversationParticipants.findFirst({ where: eq(conversationParticipants.agentId, fixer.id) });
    if (!conv) throw new Error("fixer has no conversation");

    const wallet = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, fixer.id) });
    if (!wallet) throw new Error("fixer has no wallet");

    const { checkAndConsumeBudget } = await import("../policy/gate");
    // Exhaust the wallet's actual daily budget before the tick under test.
    await checkAndConsumeBudget(fixer.id, wallet.dailyTokenBudget, wallet.dailyTokenBudget);

    const before = await db.query.messages.findMany({ where: eq(messages.conversationId, conv.conversationId) });

    setLLMProviderForTests({
      complete: async () => ({
        content: JSON.stringify({ action: "reply", conversationId: conv.conversationId, content: "should be blocked by budget" }),
        tokensUsed: 1,
      }),
    });
    await tickOne(fixer.id, "Fixer", "prompt", "objective");

    const after = await db.query.messages.findMany({ where: eq(messages.conversationId, conv.conversationId) });
    expect(after.length).toBe(before.length);
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
