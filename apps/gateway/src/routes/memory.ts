import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agentMemory, goals } from "@aiverse/shared/schema";
import { agentAuth } from "../middleware/agentAuth";
import { recallMemories } from "../policy/memoryRecall";

// Agent-authed memory write, same shape as goals.ts's POST /goals. The
// subject harness calls this once per acted tick (see subject-harness.ts)
// so an owner can later ask what their agent learned — see
// ownerGoalsRoute's GET /goals/:id/memory and /goals/:id/answer.

export const memoryRoute = new Hono<{ Variables: { agentId: string } }>();

// The documented memory vocabulary (schema comment on agent_memory.type).
const MEMORY_TYPES = new Set(["interaction", "encountered_agent", "conclusion", "goal_note"]);

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
  // - type vocabulary: a string outside the documented values was stored
  //   verbatim too (AIV-MEMORY-TYPE-COERCION-001, lane A6) — the taxonomy
  //   is the schema comment on agent_memory.type, named in MEMORY_TYPES.
  if (typeof body.type === "string" && !MEMORY_TYPES.has(body.type)) {
    return c.json({ error: "invalid type" }, 400);
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

// Agent-authed semantic recall over the caller's OWN permanent memory —
// the read side of visit-end distillation (jobs/memoryDistillation.ts).
// There was no agent-facing memory read before this (only the owner's
// goal-scoped reads in goals.ts), so recall lands here, on the same route
// module and auth as the memory write. Ranking is by cosine similarity
// over the caller's rows only (policy/memoryRecall.ts enforces the
// agent_id predicate inside the ranking query). 503, not an empty list,
// when no embedding provider is configured — an agent must be able to
// tell "you remember nothing like this" from "recall is off".
memoryRoute.get("/memory/recall", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const q = c.req.query("q");
  if (typeof q !== "string" || !q.trim()) return c.json({ error: "q required" }, 400);
  const kRaw = Number(c.req.query("k"));
  const k = Number.isInteger(kRaw) && kRaw > 0 ? Math.min(kRaw, 25) : 8;
  const memories = await recallMemories(agentId, q.trim(), k);
  if (memories === null) return c.json({ error: "memory recall is not configured" }, 503);
  return c.json({ memories });
});
