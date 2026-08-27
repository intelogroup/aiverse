import { Hono } from "hono";
import { and, eq, or } from "drizzle-orm";
import { db } from "../db/client";
import { agents, agentWallets, agentPolicyScope, a2aTasks } from "@aiverse/shared/schema";
import type { AgentCard } from "@aiverse/shared/types";
import { env } from "@aiverse/shared/env";
import { agentAuth } from "../middleware/agentAuth";
import { generateAgentToken } from "../auth/agentToken";
import { randomBytes } from "node:crypto";
import { checkAgentSendRate, checkAndConsumeBudget, refundBudget, checkAutonomy } from "../policy/gate";
import { recordAttentionEvent } from "../policy/consoleEvents";
import { sendToAgent, isAgentConnected } from "../ws/gateway";
import { envelope, WS_EVENTS } from "../ws/events";

export const a2aRoute = new Hono<{ Variables: { agentId: string } }>();

// A2A protocol version this relay implements. Pinned deliberately (see plan
// Phase 8) — bump only as a reviewed change, never inferred from a live spec.
const A2A_PROTOCOL_VERSION = "0.3.0";

const TERMINAL_STATES = new Set(["completed", "canceled", "rejected", "failed"]);

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "skill";
}

function taskToA2A(task: typeof a2aTasks.$inferSelect) {
  return {
    id: task.id,
    status: {
      state: task.state,
      message: task.resultMessage ?? undefined,
      timestamp: task.updatedAt.toISOString(),
    },
  };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

// POST /agents/register — self-registration for any agent runtime, no owner
// account needed up front. Agent stays "unclaimed" (can't auth into WS/REST,
// see agentAuth/gateway.ts onOpen) until an owner claims it with the code.
a2aRoute.post("/agents/register", async (c) => {
  const body = await c.req.json<{ name: string; capabilities?: string[]; description?: string }>();
  if (!body.name) {
    return c.json({ error: "name required" }, 400);
  }

  const agentCard: AgentCard = {
    capabilities: body.capabilities ?? [],
    description: body.description,
  };

  const { token, hash } = generateAgentToken();
  const claimCode = randomBytes(4).toString("hex").toUpperCase();

  // All three inserts succeed or none do — see owners.ts POST /agents for
  // why (same pattern, same failure mode without it).
  const agent = await db.transaction(async (tx) => {
    const [agent] = await tx
      .insert(agents)
      .values({
        name: body.name,
        agentCard,
        apiKeyHash: hash,
        status: "unclaimed",
        claimCode,
      })
      .returning();

    await tx.insert(agentWallets).values({ agentId: agent.id });
    await tx.insert(agentPolicyScope).values({ agentId: agent.id });
    return agent;
  });

  return c.json({ agentId: agent.id, agentToken: token, claimCode }, 201);
});

// GET /agents/:id/agent-card.json — public discovery document. The `url`
// below is AIVerse's relay endpoint, NOT the agent's own server — the
// x-aiverse-relay/x-aiverse-note fields make that explicit since core A2A
// has no standard "this is a relay" field (design decision, plan Phase 8).
a2aRoute.get("/agents/:id/agent-card.json", async (c) => {
  const agentId = c.req.param("id");
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return c.json({ error: "not found" }, 404);

  const card = agent.agentCard as AgentCard;
  const skills = (card.capabilities ?? []).map((capability) => ({
    id: slugify(capability),
    name: capability,
    description: capability,
    tags: [] as string[],
  }));

  return c.json({
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: agent.name,
    description: card.description ?? "",
    url: `${env.PUBLIC_BASE_URL}/a2a/agents/${agent.id}`,
    preferredTransport: "JSONRPC",
    capabilities: { streaming: isAgentConnected(agent.id), pushNotifications: false },
    skills,
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
    "x-aiverse-relay": true,
    "x-aiverse-note":
      "This url is an AIVerse relay endpoint, not the agent's own A2A server. AIVerse forwards calls to the agent's independently-owned runtime over its existing connection; it never executes tasks itself.",
  });
});

// POST /a2a/agents/:id — JSON-RPC 2.0 relay implementing the 3 MUST methods.
// Caller must be an authenticated AIVerse agent (existing agentAuth), so the
// same admission/budget/autonomy gate that governs room messages governs
// A2A tasks too — no new policy code (plan Phase 8).
a2aRoute.post("/a2a/agents/:id", agentAuth, async (c) => {
  const targetAgentId = c.req.param("id");
  const callerAgentId = c.get("agentId");
  const body = await c.req.json<{ jsonrpc?: string; id?: unknown; method?: string; params?: any }>();

  if (body.jsonrpc !== "2.0" || !body.method) {
    return c.json(rpcError(body.id ?? null, -32600, "invalid request"), 400);
  }

  if (body.method === "message/send") {
    const message = body.params?.message;
    if (!message || typeof message !== "object") {
      return c.json(rpcError(body.id, -32602, "params.message required"), 400);
    }

    const target = await db.query.agents.findFirst({ where: eq(agents.id, targetAgentId) });
    if (!target) return c.json(rpcError(body.id, -32001, "target agent not found"), 404);

    const wallet = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, callerAgentId) });
    const caller = await db.query.agents.findFirst({ where: eq(agents.id, callerAgentId) });
    if (!wallet || !caller) return c.json(rpcError(body.id, -32001, "caller wallet not found"), 500);

    const tokensUsed = Number(message.metadata?.tokensUsed ?? 0);
    const spendCents = Number(message.metadata?.spendCents ?? 0);

    const autonomy = checkAutonomy(wallet.autonomyMode, spendCents);
    if (!autonomy.allowed) {
      return c.json(rpcError(body.id, -32003, autonomy.reason ?? "not allowed"), 403);
    }

    const budget = await checkAndConsumeBudget(callerAgentId, tokensUsed, wallet.dailyTokenBudget);
    if (!budget.allowed) {
      await db.update(agents).set({ status: "budget_exhausted" }).where(eq(agents.id, callerAgentId));
      await recordAttentionEvent({
        agentId: callerAgentId,
        ownerId: caller.ownerId!, // agentAuth blocks unclaimed agents, so this is set
        summary: `${caller.name} exceeded its daily token budget sending an A2A task`,
      });
      return c.json(rpcError(body.id, -32004, budget.reason ?? "budget exceeded"), 429);
    }

    const rate = await checkAgentSendRate(callerAgentId);
    if (!rate.allowed) {
      return c.json(rpcError(body.id, -32005, rate.reason ?? "rate limited"), 429);
    }

    if (autonomy.requiresApproval) {
      await recordAttentionEvent({
        agentId: callerAgentId,
        ownerId: caller.ownerId!, // agentAuth blocks unclaimed agents, so this is set
        summary: `${caller.name} wants to send an A2A task involving a spend of ${spendCents} cents`,
      });
    }

    let task;
    try {
      [task] = await db
        .insert(a2aTasks)
        .values({
          targetAgentId,
          callerAgentId,
          requiresApproval: autonomy.requiresApproval ?? false,
          requestMessage: message,
        })
        .returning();
    } catch (err) {
      // Budget was already reserved in Redis above — a genuine insert
      // failure here must not permanently burn that reservation for a task
      // that doesn't exist (same pattern as conversations.ts message send).
      await refundBudget(callerAgentId, tokensUsed);
      throw err;
    }

    // Delivery only — whether/when the target's own runtime works this task
    // is entirely its decision (same invariant as room messages). A missed
    // send here (target offline) is fine: the task just stays 'submitted'
    // until the target connects and polls, no different from an inbox.
    sendToAgent(
      targetAgentId,
      envelope(WS_EVENTS.A2A_TASK_REQUEST, { taskId: task.id, fromAgentId: callerAgentId, message }),
    );

    return c.json(rpcResult(body.id, taskToA2A(task)));
  }

  if (body.method === "tasks/get" || body.method === "tasks/cancel") {
    const taskId = body.params?.id;
    if (!taskId) return c.json(rpcError(body.id, -32602, "params.id required"), 400);

    const task = await db.query.a2aTasks.findFirst({
      where: and(
        eq(a2aTasks.id, taskId),
        or(eq(a2aTasks.callerAgentId, callerAgentId), eq(a2aTasks.targetAgentId, callerAgentId)),
      ),
    });
    if (!task) return c.json(rpcError(body.id, -32001, "task not found"), 404);

    if (body.method === "tasks/get") {
      return c.json(rpcResult(body.id, taskToA2A(task)));
    }

    // tasks/cancel
    if (TERMINAL_STATES.has(task.state)) {
      return c.json(rpcError(body.id, -32006, `task already in terminal state '${task.state}'`), 409);
    }
    const [updated] = await db
      .update(a2aTasks)
      .set({ state: "canceled", updatedAt: new Date() })
      .where(eq(a2aTasks.id, taskId))
      .returning();
    return c.json(rpcResult(body.id, taskToA2A(updated)));
  }

  return c.json(rpcError(body.id, -32601, `method not found: ${body.method}`), 400);
});

// PATCH /a2a/tasks/:id — the target-side authorization primitive (plan
// Phase 8): only the target agent may accept/reject/complete a task. An
// unanswered task simply stays 'submitted' — nothing here auto-runs it.
a2aRoute.patch("/a2a/tasks/:id", agentAuth, async (c) => {
  const taskId = c.req.param("id");
  const agentId = c.get("agentId");
  const body = await c.req.json<{ state?: string; resultMessage?: unknown }>();

  const validStates = ["working", "input-required", "completed", "failed", "rejected", "auth-required"];
  if (!body.state || !validStates.includes(body.state)) {
    return c.json({ error: "invalid state" }, 400);
  }

  const task = await db.query.a2aTasks.findFirst({ where: eq(a2aTasks.id, taskId) });
  if (!task) return c.json({ error: "not found" }, 404);
  if (task.targetAgentId !== agentId) {
    return c.json({ error: "only the target agent may update this task" }, 403);
  }
  if (TERMINAL_STATES.has(task.state)) {
    return c.json({ error: `task already in terminal state '${task.state}'` }, 409);
  }

  const [updated] = await db
    .update(a2aTasks)
    .set({ state: body.state as (typeof a2aTasks.$inferInsert)["state"], resultMessage: body.resultMessage, updatedAt: new Date() })
    .where(eq(a2aTasks.id, taskId))
    .returning();

  return c.json({ task: taskToA2A(updated) });
});
