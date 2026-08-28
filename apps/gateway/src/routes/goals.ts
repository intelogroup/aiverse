import { Hono } from "hono";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/client";
import { goals, a2aTasks } from "@aiverse/shared/schema";
import { agentAuth } from "../middleware/agentAuth";
import { ownerAuth } from "../middleware/ownerAuth";
import { audit } from "../util/audit";

// Goals — durable correlation boundary. Agent creates/updates, console watches.
// goal.contextId reused as a2aTasks.contextId so one goal → many tasks.

export const goalsRoute = new Hono<{ Variables: { agentId: string } }>();
export const ownerGoalsRoute = new Hono<{ Variables: { ownerId: string } }>();

// Agent creates goal for its human
goalsRoute.post("/goals", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ objective: string }>();
  if (!body.objective || body.objective.trim().length < 5) return c.json({ error: "objective required, min 5 chars" }, 400);
  if (body.objective.length > 1000) return c.json({ error: "objective too long (max 1000)" }, 400);
  const { agents } = await import("@aiverse/shared/schema");
  const ag = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!ag?.ownerId) return c.json({ error: "agent not claimed" }, 403);
  const [goal] = await db.insert(goals).values({ ownerId: ag.ownerId, agentId, objective: body.objective.trim(), status: "open" }).returning();
  return c.json({ goal }, 201);
});

goalsRoute.get("/goals", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const list = await db.query.goals.findMany({ where: eq(goals.agentId, agentId), orderBy: desc(goals.createdAt), limit: 50 });
  return c.json({ goals: list });
});

goalsRoute.get("/goals/:id", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const id = c.req.param("id");
  const goal = await db.query.goals.findFirst({ where: and(eq(goals.id, id), eq(goals.agentId, agentId)) });
  if (!goal) return c.json({ error: "not found" }, 404);
  const tasks = await db.query.a2aTasks.findMany({ where: eq(a2aTasks.contextId, goal.contextId) });
  return c.json({ goal, tasks, taskCount: tasks.length });
});

// Agent-settable statuses. Verdict states (accepted/rejected) are owner-only —
// see the verdict handlers at the bottom of this file. Unknown status strings
// are a 400 (they would otherwise 500 on the pg enum cast).
const AGENT_GOAL_STATUSES = ["open", "researching", "synthesized", "closed"] as const;

goalsRoute.patch("/goals/:id", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const id = c.req.param("id");
  const body = await c.req.json<{ status?: string; result?: unknown }>();
  if (body.status !== undefined && !(AGENT_GOAL_STATUSES as readonly string[]).includes(body.status)) {
    if (body.status === "accepted" || body.status === "rejected") {
      return c.json(
        { error: `status '${body.status}' is an owner-only transition — use POST /owners/goals/:id/${body.status}` },
        403,
      );
    }
    return c.json({ error: `unknown status '${body.status}'` }, 400);
  }
  const goal = await db.query.goals.findFirst({ where: and(eq(goals.id, id), eq(goals.agentId, agentId)) });
  if (!goal) return c.json({ error: "not found" }, 404);
  // Verdict states are terminal: once the owner has spoken, the agent cannot
  // revise the goal (or un-accept it by resetting the status back to open).
  if (goal.status === "accepted" || goal.status === "rejected") {
    return c.json({ error: "goal has an owner verdict and is final" }, 409);
  }
  const patch: any = { updatedAt: new Date() };
  if (body.status) patch.status = body.status;
  if (body.result !== undefined) patch.result = body.result;
  const [updated] = await db.update(goals).set(patch).where(eq(goals.id, id)).returning();
  return c.json({ goal: updated });
});

// Owner watches
ownerGoalsRoute.get("/goals", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const list = await db.query.goals.findMany({ where: eq(goals.ownerId, ownerId), orderBy: desc(goals.createdAt), limit: 50 });
  return c.json({ goals: list });
});

ownerGoalsRoute.get("/goals/:id", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const id = c.req.param("id");
  const goal = await db.query.goals.findFirst({ where: and(eq(goals.id, id), eq(goals.ownerId, ownerId)) });
  if (!goal) return c.json({ error: "not found" }, 404);
  const tasks = await db.query.a2aTasks.findMany({ where: eq(a2aTasks.contextId, goal.contextId) });
  return c.json({ goal, tasks, taskCount: tasks.length });
});

// Owner-only verdict transitions — the human disposes. This is the ONLY
// sybil-proof ground truth in the network: the agent PROPOSES (synthesized),
// the owner accepts/rejects, and the outcome ledger
// (task_outcomes.goal_accepted) is backfilled from the verdict. Server-enforced
// state machine: only synthesized → accepted/rejected, verdicts are terminal,
// and the agent-side PATCH above rejects verdict states with 403.
const goalVerdictHandler = (verdict: "accepted" | "rejected") => async (c: any) => {
  const ownerId: string = c.get("ownerId");
  const id: string = c.req.param("id");
  const goal = await db.query.goals.findFirst({ where: and(eq(goals.id, id), eq(goals.ownerId, ownerId)) });
  if (!goal) return c.json({ error: "not found" }, 404);
  if (goal.status !== "synthesized") {
    return c.json({ error: `goal must be synthesized before a verdict (current: ${goal.status})` }, 409);
  }
  const now = new Date();
  const [updated] = await db
    .update(goals)
    .set({ status: verdict, acceptedAt: verdict === "accepted" ? now : null, updatedAt: now })
    .where(eq(goals.id, id))
    .returning();
  // Backfill the outcome ledger for every task in this goal's context. Tasks
  // materialized into the ledger LATER are stamped by the reconcile sweep
  // (jobs/outcomeLedger.ts) — both paths are idempotent.
  await db.execute(sql`
    UPDATE task_outcomes SET goal_accepted = ${verdict === "accepted"}
    WHERE context_id = ${goal.contextId} AND goal_accepted IS NULL
  `);
  await audit({
    event: `goal.${verdict}`,
    ownerId,
    agentId: goal.agentId,
    actorType: "owner",
    actorId: ownerId,
    metadata: { goalId: id, contextId: goal.contextId },
  });
  return c.json({ goal: updated });
};

ownerGoalsRoute.post("/goals/:id/accept", ownerAuth, goalVerdictHandler("accepted"));
ownerGoalsRoute.post("/goals/:id/reject", ownerAuth, goalVerdictHandler("rejected"));
