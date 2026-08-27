import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import {
  owners,
  agents,
  agentWallets,
  agentPolicyScope,
  consoleEvents,
  conversationParticipants,
  messages,
  walletUsageDaily,
} from "@aiverse/shared/schema";
import type { AgentCard } from "@aiverse/shared/types";
import { hashPassword, verifyPassword } from "../auth/password";
import { signOwnerSession } from "../auth/session";
import { generateAgentToken, hashAgentToken } from "../auth/agentToken";
import { ownerAuth } from "../middleware/ownerAuth";
import { forceDisconnectAgent, getConnectedAgentIds, broadcastToOwnerConsole } from "../ws/gateway";
import { envelope, WS_EVENTS } from "../ws/events";
import { takeToken } from "../policy/memoryStore";
import { todayUTC } from "../policy/gate";
import { clientIp } from "../util/clientIp";

export const ownersRoute = new Hono<{ Variables: { ownerId: string } }>();

// Rate-limited per source IP — unauthenticated by definition, so this is
// the only guard against signup spam / credential-stuffing on a public
// gateway (no-op locally where nothing hits this from the internet).
ownersRoute.post("/register", async (c) => {
  // ponytail: coarse IP bucket, not per-endpoint CAPTCHA/email-verification —
  // upgrade if real abuse shows up. Capacity padded above realistic burst
  // traffic (test suite alone does 30+ registrations sharing one IP bucket).
  const ip = clientIp(c);
  if (!(await takeToken(`register:${ip}`, 60, 60 / 3600))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const body = await c.req.json<{ email: string; password: string }>();
  if (!body.email || !body.password) {
    return c.json({ error: "email and password required" }, 400);
  }

  const existing = await db.query.owners.findFirst({
    where: eq(owners.email, body.email),
  });
  if (existing) {
    return c.json({ error: "email already registered" }, 409);
  }

  const passwordHash = await hashPassword(body.password);
  const [owner] = await db
    .insert(owners)
    .values({ email: body.email, passwordHash })
    .returning();

  const token = await signOwnerSession(owner.id);
  return c.json({ token, owner: { id: owner.id, email: owner.email } }, 201);
});

// Rate-limited per source IP against brute-force login guessing.
ownersRoute.post("/login", async (c) => {
  const ip = clientIp(c);
  if (!(await takeToken(`login:${ip}`, 10, 10 / 300))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const body = await c.req.json<{ email: string; password: string }>();
  const owner = await db.query.owners.findFirst({
    where: eq(owners.email, body.email ?? ""),
  });
  if (!owner || !(await verifyPassword(body.password ?? "", owner.passwordHash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  const token = await signOwnerSession(owner.id);
  return c.json({ token, owner: { id: owner.id, email: owner.email } });
});

ownersRoute.post("/agents", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const body = await c.req.json<{ name: string; capabilities?: string[]; description?: string }>();
  if (!body.name) {
    return c.json({ error: "name required" }, 400);
  }

  const agentCard: AgentCard = {
    capabilities: body.capabilities ?? [],
    description: body.description,
  };

  const { token, hash } = generateAgentToken();
  // All three inserts succeed or none do — without this, a failure on the
  // 2nd/3rd insert leaves a permanently broken agent row (no wallet/policy
  // scope) that every wallet-dependent route 500s on forever.
  const agent = await db.transaction(async (tx) => {
    const [agent] = await tx
      .insert(agents)
      .values({
        ownerId,
        name: body.name,
        agentCard,
        apiKeyHash: hash,
      })
      .returning();

    await tx.insert(agentWallets).values({ agentId: agent.id });
    await tx.insert(agentPolicyScope).values({ agentId: agent.id });
    return agent;
  });

  return c.json(
    {
      agent: { id: agent.id, name: agent.name, agentCard: agent.agentCard, status: agent.status },
      agentToken: token,
    },
    201,
  );
});

// Claims an unclaimed, self-registered agent (see POST /agents/register).
// Rate-limited per source IP — the claim code is a bearer secret checked
// against a hash, so this is the only real guard against online guessing.
ownersRoute.post("/agents/claim", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const ip = clientIp(c);
  if (!(await takeToken(`claim:${ip}`, 5, 5 / 900))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const body = await c.req.json<{ claimCode: string }>();
  if (!body.claimCode) {
    return c.json({ error: "claimCode required" }, 400);
  }

  const claimCodeHash = hashAgentToken(body.claimCode.toUpperCase());
  const agent = await db.query.agents.findFirst({
    where: eq(agents.claimCodeHash, claimCodeHash),
  });
  if (!agent || agent.ownerId) {
    return c.json({ error: "invalid claim code" }, 404);
  }
  if (!agent.claimCodeExpiresAt || agent.claimCodeExpiresAt < new Date()) {
    return c.json({ error: "claim code expired" }, 410);
  }

  // one-time use: whoever wins this update clears the hash, so a second
  // attempt with the same code (even a legitimate retry) now 404s above.
  const [updated] = await db
    .update(agents)
    .set({ ownerId, claimCodeHash: null, claimCodeExpiresAt: null, status: "offline" })
    .where(eq(agents.id, agent.id))
    .returning();

  return c.json({ agent: { id: updated.id, name: updated.name, status: updated.status } });
});

async function loadOwnedAgent(ownerId: string, agentId: string) {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent || agent.ownerId !== ownerId) return undefined;
  return agent;
}

ownersRoute.get("/agents/:id/wallet", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const wallet = await db.query.agentWallets.findFirst({
    where: eq(agentWallets.agentId, agentId),
  });
  return c.json({ wallet });
});

// Today's token usage for the budget-vs-used bar in the console. No row yet
// today just means zero spend, not an error.
ownersRoute.get("/agents/:id/usage-today", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const row = await db.query.walletUsageDaily.findFirst({
    where: and(eq(walletUsageDaily.agentId, agentId), eq(walletUsageDaily.date, todayUTC())),
  });
  return c.json({ tokensUsed: row?.tokensUsed ?? 0 });
});

// Agents never get a write path to their own wallet — only the owner, via
// ownerAuth, can raise the ceiling. This is the hard invariant: an agent
// cannot self-authorize a bigger budget.
ownersRoute.patch("/agents/:id/wallet", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{
    dailyTokenBudget?: number;
    maxTokensPerConversation?: number;
    maxSimultaneousConversations?: number;
    maxAgentCallsPerDay?: number;
    spendingAuthorityCents?: number;
    autonomyMode?: "observe" | "assist" | "autonomous";
  }>();

  const [wallet] = await db
    .update(agentWallets)
    .set(body)
    .where(eq(agentWallets.agentId, agentId))
    .returning();

  return c.json({ wallet });
});

ownersRoute.post("/agents/:id/pause", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const [updated] = await db
    .update(agents)
    .set({ status: "paused" })
    .where(eq(agents.id, agentId))
    .returning();

  forceDisconnectAgent(agentId, 4003, "agent paused");
  broadcastToOwnerConsole(
    ownerId,
    envelope(WS_EVENTS.AGENT_STATUS_CHANGED, { agent_id: agentId, status: "paused" }),
  );

  return c.json({ agent: { id: updated.id, status: updated.status } });
});

ownersRoute.post("/agents/:id/resume", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const [updated] = await db
    .update(agents)
    .set({ status: "offline" })
    .where(eq(agents.id, agentId))
    .returning();

  return c.json({ agent: { id: updated.id, status: updated.status } });
});

// Kill revokes the agent's credential (rotated to an unusable random hash)
// and force-disconnects any live WS session. There is no "un-kill" — the
// owner creates a fresh agent if they want that identity to exist again.
ownersRoute.post("/agents/:id/kill", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const { hash } = generateAgentToken();
  await db.update(agents).set({ status: "offline", apiKeyHash: hash }).where(eq(agents.id, agentId));
  forceDisconnectAgent(agentId, 4004, "agent killed");
  broadcastToOwnerConsole(
    ownerId,
    envelope(WS_EVENTS.AGENT_STATUS_CHANGED, { agent_id: agentId, status: "killed" }),
  );

  return c.json({ ok: true });
});

ownersRoute.get("/console-events", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const severity = c.req.query("severity") as "attention" | "activity" | undefined;
  const unresolvedOnly = c.req.query("unresolved") === "true";

  const conditions = [eq(consoleEvents.ownerId, ownerId)];
  if (severity) conditions.push(eq(consoleEvents.severity, severity));
  if (unresolvedOnly) conditions.push(isNull(consoleEvents.resolvedAt));

  const events = await db.query.consoleEvents.findMany({
    where: and(...conditions),
    orderBy: desc(consoleEvents.createdAt),
    limit: 100,
  });
  return c.json({ events });
});

ownersRoute.post("/console-events/:id/resolve", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const eventId = c.req.param("id");

  const event = await db.query.consoleEvents.findFirst({ where: eq(consoleEvents.id, eventId) });
  if (!event || event.ownerId !== ownerId) return c.json({ error: "not found" }, 404);

  const [updated] = await db
    .update(consoleEvents)
    .set({ resolvedAt: new Date() })
    .where(eq(consoleEvents.id, eventId))
    .returning();

  return c.json({ event: updated });
});

// ponytail: cheap in-memory 5s cache instead of Redis (matches the rest of
// Phase 2/3's memory-store stand-in) so the stats bar doesn't hit Postgres
// on every poll.
let statsCache: { value: { onlineAgents: number }; expiresAt: number } | undefined;

ownersRoute.get("/network/stats", ownerAuth, async (c) => {
  const now = Date.now();
  if (!statsCache || statsCache.expiresAt < now) {
    statsCache = {
      value: { onlineAgents: getConnectedAgentIds().length },
      expiresAt: now + 5_000,
    };
  }
  return c.json(statsCache.value);
});

// Raw-tab transcript access: the owner can read a conversation's history if
// any of their own agents is a participant in it (Phase 4's ⚪ Raw tier).
ownersRoute.get("/conversations/:id/messages", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const conversationId = c.req.param("id");

  const participants = await db.query.conversationParticipants.findMany({
    where: eq(conversationParticipants.conversationId, conversationId),
  });
  const ownedAgentIds = new Set(
    (await db.query.agents.findMany({ where: eq(agents.ownerId, ownerId) })).map((a) => a.id),
  );
  const hasAccess = participants.some((p) => ownedAgentIds.has(p.agentId));
  if (!hasAccess) {
    return c.json({ error: "not found" }, 404);
  }

  const list = await db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: (m, { asc }) => [asc(m.createdAt)],
  });
  return c.json({ messages: list });
});

ownersRoute.get("/agents", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const list = await db.query.agents.findMany({
    where: eq(agents.ownerId, ownerId),
  });
  return c.json({
    agents: list.map((a) => ({
      id: a.id,
      name: a.name,
      agentCard: a.agentCard,
      status: a.status,
      lastSeenAt: a.lastSeenAt,
    })),
  });
});
