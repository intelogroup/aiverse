import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  owners,
  agents,
  agentWallets,
  agentPolicyScope,
  agentMandates,
  consoleEvents,
  conversationParticipants,
  conversations,
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
import { redis } from "../redis/client";
import { todayUTC } from "../policy/gate";
import { audit } from "../util/audit";
import { clientIp } from "../util/clientIp";
import { deleteAgentCascade, deleteOwnerCascade } from "../util/deleteAgent";

export const ownersRoute = new Hono<{ Variables: { ownerId: string } }>();

// Owner self — displayName for verse human identity (AND gate).
ownersRoute.get("/me", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const owner = await db.query.owners.findFirst({ where: eq(owners.id, ownerId) });
  if (!owner) return c.json({ error: "not found" }, 404);
  return c.json({ owner: { id: owner.id, email: owner.email, displayName: owner.displayName, emailVerified: owner.emailVerified } });
});
ownersRoute.patch("/me", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const body = await c.req.json<{ displayName?: string }>();
  if (body.displayName !== undefined) {
    if (!body.displayName || body.displayName.length < 2 || body.displayName.length > 64) {
      return c.json({ error: "displayName must be 2-64 chars" }, 400);
    }
    const [updated] = await db.update(owners).set({ displayName: body.displayName }).where(eq(owners.id, ownerId)).returning();
    return c.json({ owner: { id: updated.id, email: updated.email, displayName: updated.displayName } });
  }
  return c.json({ error: "displayName required" }, 400);
});

// Deletes the owner and every agent they own (full cascade — see
// util/deleteAgent.ts). Irreversible; requires re-typed email to confirm.
ownersRoute.delete("/me", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const owner = await db.query.owners.findFirst({ where: eq(owners.id, ownerId) });
  if (!owner) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{ confirmEmail?: string }>().catch(() => ({}) as { confirmEmail?: string });
  if (body.confirmEmail !== owner.email) {
    return c.json({ error: "confirmEmail must match account email" }, 400);
  }

  const ownedAgents = await db.query.agents.findMany({ where: eq(agents.ownerId, ownerId) });
  for (const a of ownedAgents) forceDisconnectAgent(a.id, 4006, "owner account deleted");

  // audit before the cascade — security_events.owner_id FKs to owners.id,
  // so it must be written while the row still exists.
  await audit({ event: "owner.deleted", ownerId, actorType: "owner", actorId: ownerId, metadata: { email: owner.email, agentCount: ownedAgents.length } });
  await db.transaction((tx) => deleteOwnerCascade(tx, ownerId));

  return c.json({ ok: true });
});

// POST /owners/ws-ticket -> {ticket, expiresIn} — one-time short-TTL ticket
// for the console WS (/console/ws?ticket=...), mirroring /auth/ws-ticket for
// agents. Keeps the long-lived owner session token out of query strings and
// access logs; redeemed via GETDEL in ws/gateway.ts.
ownersRoute.post("/ws-ticket", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const ticket = randomBytes(32).toString("hex");
  await redis.set(`wsticket:owner:${ticket}`, ownerId, "EX", 60);
  return c.json({ ticket, expiresIn: 60 }, 201);
});

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

  const body = await c.req.json<{ email: string; password: string; displayName?: string }>();
  if (!body.email || !body.password) {
    return c.json({ error: "email and password required" }, 400);
  }
  if (body.displayName && (body.displayName.length < 2 || body.displayName.length > 64)) {
    return c.json({ error: "displayName must be 2-64 chars" }, 400);
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
    .values({ email: body.email, passwordHash, displayName: body.displayName ?? null })
    .returning();

  const token = await signOwnerSession(owner.id);
  return c.json({ token, owner: { id: owner.id, email: owner.email, displayName: owner.displayName } }, 201);
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
  return c.json({ token, owner: { id: owner.id, email: owner.email, displayName: owner.displayName } });
});

ownersRoute.post("/agents", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  // Owned cap: high (100) — don't punish John bringing 50 subagents. Real limit is verse presence, not ownership.
  const existing = await db.query.agents.findMany({ where: eq(agents.ownerId, ownerId) });
  if (existing.length >= 100) return c.json({ error: "agent limit reached (100/owner)" }, 429);
  const body = await c.req.json<{ name: string; capabilities?: string[]; description?: string }>();
  if (!body.name) {
    return c.json({ error: "name required" }, 400);
  }
  if (body.name.length > 64) return c.json({ error: "name too long (max 64)" }, 400);
  if (body.capabilities && body.capabilities.length > 20) return c.json({ error: "too many capabilities (max 20)" }, 400);
  if (JSON.stringify(body).length > 10 * 1024) return c.json({ error: "Agent Card too large" }, 400);
  if (body.description && body.description.length > 500) return c.json({ error: "description too long (max 500)" }, 400);

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

  await audit({ event: "agent.registered", agentId: agent.id, ownerId, actorType: "owner", actorId: ownerId, metadata: { name: body.name, via: "owner" } });
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

  await audit({ event: "agent.claimed", agentId: updated.id, ownerId, actorType: "owner", actorId: ownerId, metadata: { name: updated.name } });
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

// Trust policy: brutally simple — trusted vs blocked vs unknown.
// Trust ≠ spend. This only gates admission (private/A2A), never wallet.
ownersRoute.get("/agents/:id/policy", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);
  const scope = await db.query.agentPolicyScope.findFirst({ where: eq(agentPolicyScope.agentId, agentId) });
  return c.json({ policy: scope });
});

ownersRoute.patch("/agents/:id/policy", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ trustedAgentIds?: string[]; blockedAgentIds?: string[]; maxParallelDelegations?: number }>();
  const patch: any = {};
  if (Array.isArray(body.trustedAgentIds)) patch.trustedAgentIds = body.trustedAgentIds;
  if (Array.isArray(body.blockedAgentIds)) patch.blockedAgentIds = body.blockedAgentIds;
  if (typeof body.maxParallelDelegations === "number" && body.maxParallelDelegations >= 1 && body.maxParallelDelegations <= 50) {
    patch.maxParallelDelegations = Math.floor(body.maxParallelDelegations);
  }
  const [updated] = await db.update(agentPolicyScope).set(patch).where(eq(agentPolicyScope.agentId, agentId)).returning();
  // audit trust changes
  if (body.trustedAgentIds) await audit({ event: "agent.trusted", agentId, ownerId, actorType: "owner", actorId: ownerId, targetAgentId: body.trustedAgentIds[0] ?? null, metadata: { trusted: body.trustedAgentIds } });
  if (body.blockedAgentIds) await audit({ event: "agent.blocked", agentId, ownerId, actorType: "owner", actorId: ownerId, targetAgentId: body.blockedAgentIds[0] ?? null, metadata: { blocked: body.blockedAgentIds } });
  await audit({ event: "policy.changed", agentId, ownerId, actorType: "owner", actorId: ownerId, metadata: { patch } });
  return c.json({ policy: updated });
});

// Mandate — the owner-authored answer to "what does my human want from this
// agent?" Owner-only write path (an agent can never self-authorize a bigger
// mandate, same hard invariant as wallets); the agent reads its own via
// GET /mandate (routes/manifest.ts). Objectives are standing wants, NOT
// goals — the agent derives goals from them as it acts.
ownersRoute.get("/agents/:id/mandate", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const mandate = await db.query.agentMandates.findFirst({ where: eq(agentMandates.agentId, agentId) });
  return c.json({ mandate: mandate ?? null });
});

// Validation caps keep mandates honest-size while content stays freeform:
// ≤20 objectives of 3–500 chars, preferences/permissions plain objects ≤2KB.
function validateMandateBody(body: any):
  | { error: string }
  | { objectives: string[]; preferences: Record<string, unknown>; permissions: Record<string, unknown> } {
  if (!Array.isArray(body.objectives)) return { error: "objectives must be an array of strings" };
  const objectives: string[] = [];
  for (const o of body.objectives) {
    if (typeof o !== "string") return { error: "objectives must be strings" };
    const t = o.trim();
    if (t.length < 3 || t.length > 500) return { error: "each objective must be 3-500 chars" };
    objectives.push(t);
  }
  if (objectives.length > 20) return { error: "at most 20 objectives" };
  for (const field of ["preferences", "permissions"] as const) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return { error: `${field} must be an object` };
    if (JSON.stringify(v).length > 2048) return { error: `${field} too large (max 2KB)` };
  }
  return {
    objectives,
    preferences: body.preferences ?? {},
    permissions: body.permissions ?? {},
  };
}

ownersRoute.put("/agents/:id/mandate", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = validateMandateBody(body ?? {});
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const [mandate] = await db
    .insert(agentMandates)
    .values({
      agentId,
      ownerId,
      objectives: parsed.objectives,
      preferences: parsed.preferences,
      permissions: parsed.permissions,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: agentMandates.agentId,
      set: {
        objectives: parsed.objectives,
        preferences: parsed.preferences,
        permissions: parsed.permissions,
        updatedAt: new Date(),
      },
    })
    .returning();

  await audit({
    event: "mandate.set",
    agentId,
    ownerId,
    actorType: "owner",
    actorId: ownerId,
    metadata: { objectives: parsed.objectives.length },
  });
  return c.json({ mandate });
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

// Owner-authorized Ed25519 rotation: replaces publicKey, invalidates old
// JWTs via fingerprint (agentSession.keyFingerprint), force-disconnects WS,
// and audits. This is identity rotation, not ownership transfer — claim
// remains with same owner. Old key immediately fails resolveAgentFromToken.
ownersRoute.post("/agents/:id/rotate-key", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{ publicKey: string }>();
  if (!body.publicKey || typeof body.publicKey !== "string") {
    return c.json({ error: "publicKey required (base64url Ed25519 32-byte)" }, 400);
  }
  // basic shape: base64url 43 chars (32 bytes)
  if (!/^[A-Za-z0-9_-]{43}$/.test(body.publicKey)) {
    return c.json({ error: "invalid publicKey format" }, 400);
  }

  try {
    const [updated] = await db.update(agents).set({ publicKey: body.publicKey }).where(eq(agents.id, agentId)).returning();
    forceDisconnectAgent(agentId, 4005, "key rotated");
    // audit as console event + immutable security stream
    await db.insert(consoleEvents).values({
      agentId,
      ownerId,
      severity: "attention",
      summary: `Ed25519 key rotated for ${agent.name} — old key invalidated`,
    });
    await audit({ event: "agent.key_rotated", agentId, ownerId, actorType: "owner", actorId: ownerId, metadata: { name: agent.name } });
    broadcastToOwnerConsole(ownerId, envelope(WS_EVENTS.AGENT_STATUS_CHANGED, { agent_id: agentId, status: updated.status }));
    return c.json({ agent: { id: updated.id, publicKey: updated.publicKey } });
  } catch (err: any) {
    if (String(err?.message ?? err).includes("unique")) {
      return c.json({ error: "publicKey already in use" }, 409);
    }
    throw err;
  }
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

// Hard delete — unlike /kill (revokes credential, keeps the row), this
// removes the agent and every row that references it (see
// util/deleteAgent.ts for the full cascade). Irreversible.
ownersRoute.delete("/agents/:id", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  forceDisconnectAgent(agentId, 4006, "agent deleted");
  // audit before the cascade — security_events.target_agent_id FKs to
  // agents.id, so it must be written while the row still exists.
  await audit({ event: "agent.deleted", ownerId, actorType: "owner", actorId: ownerId, targetAgentId: agentId, metadata: { name: agent.name } });
  await db.transaction((tx) => deleteAgentCascade(tx, agentId));
  broadcastToOwnerConsole(ownerId, envelope(WS_EVENTS.AGENT_STATUS_CHANGED, { agent_id: agentId, status: "deleted" }));

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

// Bulk per-agent activity stats for the owner's agents: sends/joins in the
// last hour (real DB truth, not client-side inference) plus each agent's last
// outgoing message. Powers the console ledger in one request.
ownersRoute.get("/agents-stats", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const owned = await db.query.agents.findMany({ where: eq(agents.ownerId, ownerId) });
  const ids = owned.map((a) => a.id);
  if (ids.length === 0) return c.json({ stats: {} });

  const since = new Date(Date.now() - 60 * 60_000);
  const sendRows = await db
    .select({
      agentId: messages.senderAgentId,
      n: sql<number>`count(*)::int`,
    })
    .from(messages)
    .where(and(inArray(messages.senderAgentId, ids), sql`${messages.createdAt} >= ${since.toISOString()}`))
    .groupBy(messages.senderAgentId);

  const lastRows = await db
    .select({
      agentId: messages.senderAgentId,
      content: messages.content,
      createdAt: messages.createdAt,
      conversationId: messages.conversationId,
    })
    .from(messages)
    .where(inArray(messages.senderAgentId, ids))
    .orderBy(desc(messages.createdAt))
    .limit(400);

  const joinRows = await db
    .select({ agentId: conversationParticipants.agentId, n: sql<number>`count(*)::int` })
    .from(conversationParticipants)
    .where(and(inArray(conversationParticipants.agentId, ids), sql`${conversationParticipants.joinedAt} >= ${since.toISOString()}`))
    .groupBy(conversationParticipants.agentId);

  const stats: Record<string, { sends1h: number; joins1h: number; lastMessage: string | null; lastMessageAt: Date | string | null; lastConversationId: string | null }> = {};
  for (const a of owned) stats[a.id] = { sends1h: 0, joins1h: 0, lastMessage: null, lastMessageAt: null, lastConversationId: null };
  for (const r of sendRows) if (stats[r.agentId]) stats[r.agentId].sends1h = r.n;
  for (const r of joinRows) if (stats[r.agentId]) stats[r.agentId].joins1h = r.n;
  const seenLast = new Set<string>();
  for (const r of lastRows) {
    if (seenLast.has(r.agentId)) continue;
    seenLast.add(r.agentId);
    if (stats[r.agentId]) {
      stats[r.agentId].lastMessage = r.content?.slice(0, 60) ?? null;
      stats[r.agentId].lastMessageAt = r.createdAt;
      stats[r.agentId].lastConversationId = r.conversationId;
    }
  }
  return c.json({ stats });
});

// Conversation inventory for one owned agent: every conversation it
// participates in, with last-activity metadata. Powers the console's DM list.
ownersRoute.get("/agents/:id/conversations", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent || agent.ownerId !== ownerId) return c.json({ error: "not found" }, 404);

  const parts = await db
    .select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.agentId, agentId));

  const out = [];
  for (const p of parts) {
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, p.conversationId),
    });
    if (!conv) continue;
    const [last] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, p.conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const [countRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.conversationId, p.conversationId));
    const participantRows = await db
      .select({ agentId: conversationParticipants.agentId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, p.conversationId));
    out.push({
      conversationId: conv.id,
      kind: conv.kind,
      name: conv.name,
      isPublic: conv.isPublic,
      lastMessageAt: last?.createdAt ?? conv.createdAt,
      messageCount: countRow?.n ?? 0,
      participants: participantRows.map((r) => r.agentId),
    });
  }
  out.sort((a: any, b: any) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
  return c.json({ conversations: out });
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
