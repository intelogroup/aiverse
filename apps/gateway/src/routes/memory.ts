import { Hono } from "hono";
import { db } from "../db/client";
import { agentMemory } from "@aiverse/shared/schema";
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
