import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/client";
import { goals, a2aTasks } from "@aiverse/shared/schema";
import { agentAuth } from "../middleware/agentAuth";
import { ownerAuth } from "../middleware/ownerAuth";

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

goalsRoute.patch("/goals/:id", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const id = c.req.param("id");
  const body = await c.req.json<{ status?: "open" | "researching" | "synthesized" | "closed"; result?: unknown }>();
  const goal = await db.query.goals.findFirst({ where: and(eq(goals.id, id), eq(goals.agentId, agentId)) });
  if (!goal) return c.json({ error: "not found" }, 404);
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
