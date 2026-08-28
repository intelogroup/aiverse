import { describe, expect, test, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, owners, goals, a2aTasks, taskOutcomes, nativeRuns } from "@aiverse/shared/schema";
import { ensureNativeAgents } from "./nativeAgents";
import { reconcileTaskOutcomes } from "./outcomeLedger";

beforeAll(async () => {
  await ensureNativeAgents();
});

function randSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("outcome ledger reconcile", () => {
  test("materializes terminal tasks with denormalized native flags, and is idempotent", async () => {
    const sage = await db.query.agents.findFirst({ where: eq(agents.name, "Sage") });
    if (!sage) throw new Error("native Sage not found");

    const [caller] = await db
      .insert(agents)
      .values({ name: `LedgerCaller-${randSuffix()}`, agentCard: {}, apiKeyHash: "ledger-test", status: "online" })
      .returning();

    const [task] = await db
      .insert(a2aTasks)
      .values({
        targetAgentId: sage.id,
        callerAgentId: caller.id,
        state: "completed",
        requestMessage: {},
        contextId: crypto.randomUUID(),
      })
      .returning();
    // non-terminal task: must NOT be materialized
    const [openTask] = await db
      .insert(a2aTasks)
      .values({
        targetAgentId: caller.id,
        callerAgentId: sage.id,
        state: "submitted",
        requestMessage: {},
        contextId: crypto.randomUUID(),
      })
      .returning();

    await reconcileTaskOutcomes();

    const row = await db.query.taskOutcomes.findFirst({ where: eq(taskOutcomes.taskId, task.id) });
    expect(row?.targetIsNative).toBe(true); // Sage is a native NPC
    expect(row?.callerIsNative).toBe(false); // freshly inserted user-side agent
    expect(row?.state).toBe("completed");
    expect(row?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(row?.goalAccepted).toBeNull(); // context has no goal — no verdict

    const openRow = await db.query.taskOutcomes.findFirst({ where: eq(taskOutcomes.taskId, openTask.id) });
    expect(openRow).toBeUndefined();

    // idempotent: a second pass neither duplicates nor mutates the row
    await reconcileTaskOutcomes();
    const rows = await db.query.taskOutcomes.findMany({ where: eq(taskOutcomes.taskId, task.id) });
    expect(rows.length).toBe(1);
  });

  test("verdict-before-materialization race: sweep stamps an accepted goal onto rows materialized later", async () => {
    const [caller] = await db
      .insert(agents)
      .values({ name: `LedgerRace-${randSuffix()}`, agentCard: {}, apiKeyHash: "ledger-test", status: "online" })
      .returning();
    const [owner] = await db
      .insert(owners)
      .values({ email: `ledger-owner-${randSuffix()}@example.com`, passwordHash: "x" })
      .returning();

    const contextId = crypto.randomUUID();
    // the goal verdict PRE-DATES the ledger row (accepted directly, as the
    // accept endpoint would have set it)
    await db.insert(goals).values({
      ownerId: owner.id,
      agentId: caller.id,
      objective: "race test objective",
      status: "accepted",
      acceptedAt: new Date(),
      contextId,
    });
    // terminal task in that context, NOT yet in the ledger
    const [task] = await db
      .insert(a2aTasks)
      .values({ contextId, targetAgentId: caller.id, callerAgentId: caller.id, state: "completed", requestMessage: {} })
      .returning();

    await reconcileTaskOutcomes();

    const row = await db.query.taskOutcomes.findFirst({ where: eq(taskOutcomes.taskId, task.id) });
    expect(row?.goalAccepted).toBe(true); // sweep caught the pre-existing verdict
  });

  test("native task with runId in request_message propagates source_run_id; ordinary task leaves it null", async () => {
    const sage = await db.query.agents.findFirst({ where: eq(agents.name, "Sage") });
    if (!sage) throw new Error("native Sage not found");

    const [caller] = await db
      .insert(agents)
      .values({ name: `RunIdCaller-${randSuffix()}`, agentCard: {}, apiKeyHash: "runid-test", status: "online" })
      .returning();

    // Create a real native_runs header row — the FK requires a valid reference
    const [run] = await db
      .insert(nativeRuns)
      .values({ mode: "mock", provider: "openrouter", agentIds: [] })
      .returning();
    const nativeRunId = run.id;

    // task WITH native run provenance
    const [nativeTask] = await db
      .insert(a2aTasks)
      .values({
        targetAgentId: sage.id,
        callerAgentId: caller.id,
        state: "completed",
        requestMessage: { runId: nativeRunId },
        contextId: crypto.randomUUID(),
      })
      .returning();

    // ordinary task WITHOUT runId
    const [plainTask] = await db
      .insert(a2aTasks)
      .values({
        targetAgentId: caller.id,
        callerAgentId: sage.id,
        state: "completed",
        requestMessage: {},
        contextId: crypto.randomUUID(),
      })
      .returning();

    // task with a WELL-FORMED but NONEXISTENT runId (no native_runs row):
    // must materialize with source_run_id = NULL, not a dangling uuid —
    // and must not poison the batch for the other two tasks.
    const [fakeRunTask] = await db
      .insert(a2aTasks)
      .values({
        targetAgentId: caller.id,
        callerAgentId: sage.id,
        state: "completed",
        requestMessage: { runId: crypto.randomUUID() }, // valid uuid, no native_runs row
        contextId: crypto.randomUUID(),
      })
      .returning();

    await reconcileTaskOutcomes();

    const nativeRow = await db.query.taskOutcomes.findFirst({ where: eq(taskOutcomes.taskId, nativeTask.id) });
    expect(nativeRow?.sourceRunId).toBe(nativeRunId);

    const plainRow = await db.query.taskOutcomes.findFirst({ where: eq(taskOutcomes.taskId, plainTask.id) });
    expect(plainRow?.sourceRunId).toBeNull();

    const fakeRunRow = await db.query.taskOutcomes.findFirst({ where: eq(taskOutcomes.taskId, fakeRunTask.id) });
    expect(fakeRunRow?.sourceRunId).toBeNull(); // nonexistent → NULL, never dangling
  });
});