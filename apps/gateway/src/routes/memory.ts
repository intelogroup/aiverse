import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agentMemory, goals } from "@aiverse/shared/schema";
import { agentAuth } from "../middleware/agentAuth";

// Agent-authed memory write, same shape as goals.ts's POST /goals. The
// subject harness calls this once per acted tick (see subject-harness.ts)
// so an owner can later ask what their agent learned — see
// ownerGoalsRoute's GET /goals/:id/memory and /goals/:id/answer.

export const memoryRoute = new Hono<{ Variables: { agentId: string } }>();

memoryRoute.post("/memory", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ type?: string; content: string; goalId?: string }>();
  // typeof first: a truthy non-string content throws TypeError on .trim()
  // (and on the .slice below) → unhandled 500 (AIV-TEXT-TYPE-001).
  if (typeof body.content !== "string" || !body.content.trim()) return c.json({ error: "content required" }, 400);

  // One validation pass for the auxiliary fields (2026-11-11 fix lane):
  // - type: a non-string was silently string-coerced into the taxonomy
  //   ("12345", "true", "[object Object]") and stored (AIV-MEMORY-TYPE-COERCION-001).
  if (body.type !== undefined && typeof body.type !== "string") {
    return c.json({ error: "type must be a string" }, 400);
  }
  // - goalId: non-string shapes (boolean, array) reached Postgres as
  //   non-text params and 500'd past the 22P02 mapper (AIV-MEMORY-GOALID-TYPE-001);
  //   a foreign or nonexistent goalId was stored verbatim, and the owner's
  //   goal-recall read serves every memory row tagged with the goal with no
  //   agent filter — one agent could plant content in another owner's
  //   recall (AIV-MEMORY-FOREIGN-GOAL-TAG-001). Require the goal to exist
  //   and belong to the caller's agent; foreign and nonexistent are the
  //   same 404 so existence never leaks across owners.
  if (body.goalId !== undefined && body.goalId !== null) {
    if (typeof body.goalId !== "string") {
      return c.json({ error: "goalId must be a string" }, 400);
    }
    const goal = await db.query.goals.findFirst({
      where: eq(goals.id, body.goalId),
      columns: { id: true, agentId: true },
    });
    if (!goal || goal.agentId !== agentId) {
      return c.json({ error: "goal not found" }, 404);
    }
  }

  const [row] = await db
    .insert(agentMemory)
    .values({
      agentId,
      type: body.type ?? "interaction",
      content: body.content.slice(0, 2000),
      goalId: body.goalId ?? null,
    })
    .returning();

  return c.json({ memory: row }, 201);
});
