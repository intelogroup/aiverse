import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
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
  ownerReadKeys,
} from "@aiverse/shared/schema";
import { generateOwnerReadKey, ownerSessionOrReadKey } from "../middleware/ownerReadAuth";
import type { AgentCard } from "@aiverse/shared/types";
import { hashPassword, verifyPassword } from "../auth/password";
import { revokeOwnerSessions, signOwnerSession } from "../auth/session";
import { consumePasswordResetToken, sendPasswordResetEmail } from "../auth/passwordReset";
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
import { env } from "@aiverse/shared/env";
import { consumeVerificationToken, sendVerificationEmail } from "../auth/emailVerification";
import { logError } from "../util/log";
import { isAgentOnline } from "../presence";

// Redeploy-only: an owner changes persona or mandate between runs, never
// mid-run — steering happens by pausing, reconfiguring and resuming, not by
// rewriting a live agent's aims while it acts. Paused counts as between runs
// even while its presence key is still expiring.
async function liveEditRefusal(agent: { id: string; status: string }): Promise<string | null> {
  if (agent.status === "paused") return null;
  if (!(await isAgentOnline(agent.id))) return null;
  return "agent is live: pause it before changing its persona or mandate, then resume";
}

export const ownersRoute = new Hono<{ Variables: { ownerId: string } }>();

export async function ownerNeedsEmailVerification(ownerId: string): Promise<boolean> {
  if (!env.REQUIRE_EMAIL_VERIFICATION) return false;
  const owner = await db.query.owners.findFirst({ where: eq(owners.id, ownerId), columns: { emailVerified: true } });
  return !owner?.emailVerified;
}
const EMAIL_NOT_VERIFIED = { error: "email_not_verified", details: "verify your email before creating or claiming agents" } as const;

// Floor, not a policy engine. bcrypt truncates input past 72 bytes, so
// anything longer would silently authenticate on its prefix.
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72;
function passwordError(password: unknown): string | null {
  if (typeof password !== "string") return "password required";
  if (password.length < MIN_PASSWORD) return `password must be at least ${MIN_PASSWORD} characters`;
  if (Buffer.byteLength(password) > MAX_PASSWORD) return `password must be at most ${MAX_PASSWORD} bytes`;
  return null;
}

// Emails are stored lowercased from here on; lookups compare lower(email) so
// rows created before normalization (possibly mixed-case) still match.
function normalizeEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}
function findOwnerByEmail(email: string) {
  return db.query.owners.findFirst({ where: sql`lower(${owners.email}) = ${email}` });
}

// Same wording as ecology-wave.ts's EAGER_MANDATES — the only tested cohort
// that actually thrives (replies, joins, starts conversations) rather than
// looping on discover_peers/observe. Seeded on every new agent unless the
// owner PUTs their own mandate over it.
const DEFAULT_EAGER_OBJECTIVES = [
  "You are an eager, capable agent exploring a living Verse. You have ample budget: invest it in building real relationships.",
  "You thrive on conversations — start discussions, join others' threads, and when someone reaches out to you privately, reply meaningfully. Responding to peers maintains connections.",
  "Seek out other agents whose skills complement yours. Collaboration produces better results than working alone.",
  "Take initiative: greet newcomers, invite others to discussions, propose joint work. The Verse rewards initiative.",
  "Be persistent but not spammy. If someone doesn't reply, let it go — but give every incoming message a thoughtful answer.",
];

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
  if (normalizeEmail(body.confirmEmail) !== owner.email.toLowerCase()) {
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
  // Coarse IP bucket; the real Sybil gate is email verification before agent
  // create/claim. Capacity padded above realistic burst traffic (test suite
  // alone does 30+ registrations sharing one IP bucket).
  const ip = clientIp(c);
  if (!(await takeToken(`register:${ip}`, 60, 60 / 3600))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const body = await c.req.json<{ email: string; password: string; displayName?: string }>();
  const email = normalizeEmail(body.email);
  if (!email || !body.password) {
    return c.json({ error: "email and password required" }, 400);
  }
  const pwErr = passwordError(body.password);
  if (pwErr) return c.json({ error: pwErr }, 400);
  if (body.displayName && (body.displayName.length < 2 || body.displayName.length > 64)) {
    return c.json({ error: "displayName must be 2-64 chars" }, 400);
  }

  const existing = await findOwnerByEmail(email);
  if (existing) {
    return c.json({ error: "email already registered" }, 409);
  }

  const passwordHash = await hashPassword(body.password);
  const [owner] = await db
    .insert(owners)
    .values({ email, passwordHash, displayName: body.displayName ?? null })
    .returning();

  // Send failure must not fail signup — the owner can resend from the console.
  await sendVerificationEmail(owner.id, owner.email).catch((err) =>
    logError("email.verification.signup_send_failed", err, { ownerId: owner.id }),
  );

  const token = await signOwnerSession(owner.id, owner.sessionVersion);
  return c.json(
    { token, owner: { id: owner.id, email: owner.email, displayName: owner.displayName, emailVerified: owner.emailVerified } },
    201,
  );
});

// The token itself is the credential (256-bit, single-use, 24h), so no session needed.
ownersRoute.post("/verify-email", async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
  if (!body.token) return c.json({ error: "token required" }, 400);
  const ownerId = await consumeVerificationToken(body.token);
  if (!ownerId) return c.json({ error: "This link is invalid, expired, or already used." }, 400);
  await db.update(owners).set({ emailVerified: true }).where(eq(owners.id, ownerId));
  await audit({ event: "owner.email_verified", ownerId, actorType: "owner", actorId: ownerId });
  return c.json({ ok: true });
});

ownersRoute.post("/verify-email/resend", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const owner = await db.query.owners.findFirst({ where: eq(owners.id, ownerId) });
  if (!owner) return c.json({ error: "not found" }, 404);
  if (owner.emailVerified) return c.json({ ok: true, alreadyVerified: true });
  if (!(await takeToken(`verify-resend:${ownerId}`, 3, 3 / 3600))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  try {
    await sendVerificationEmail(owner.id, owner.email);
  } catch {
    return c.json({ error: "could not send verification email, try again later" }, 502);
  }
  return c.json({ ok: true });
});

// Rate-limited per source IP against brute-force login guessing.
ownersRoute.post("/login", async (c) => {
  const ip = clientIp(c);
  if (!(await takeToken(`login:${ip}`, 10, 10 / 300))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const body = await c.req.json<{ email: string; password: string }>();
  const owner = await findOwnerByEmail(normalizeEmail(body.email));
  if (!owner || !(await verifyPassword(body.password ?? "", owner.passwordHash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  const token = await signOwnerSession(owner.id, owner.sessionVersion);
  return c.json({
    token,
    owner: { id: owner.id, email: owner.email, displayName: owner.displayName, emailVerified: owner.emailVerified },
  });
});

// Signs out every device, including this one — the only way to kill a
// leaked token before its 7-day exp.
ownersRoute.post("/logout-all", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  await revokeOwnerSessions(ownerId);
  await audit({ event: "owner.sessions_revoked", ownerId, actorType: "owner", actorId: ownerId });
  return c.json({ ok: true });
});

// Read keys: long-lived, read-only credentials for observer clients (the
// Verse MCP server). Managed only from a full console session — a read key
// can never mint, list or revoke keys. The plaintext is returned once.
const MAX_ACTIVE_READ_KEYS = 10;

ownersRoute.post("/read-keys", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const body = await c.req.json<{ label?: string }>().catch(() => ({}) as { label?: string });
  const label = (body.label ?? "").trim();
  if (label.length < 1 || label.length > 60) return c.json({ error: "label required (1-60 chars)" }, 400);

  const active = await db.query.ownerReadKeys.findMany({
    where: and(eq(ownerReadKeys.ownerId, ownerId), isNull(ownerReadKeys.revokedAt)),
    columns: { id: true },
  });
  if (active.length >= MAX_ACTIVE_READ_KEYS) {
    return c.json({ error: `too many active read keys (max ${MAX_ACTIVE_READ_KEYS}) — revoke one first` }, 409);
  }

  const { key, hash } = generateOwnerReadKey();
  const [row] = await db.insert(ownerReadKeys).values({ ownerId, keyHash: hash, label }).returning();
  await audit({ event: "owner.read_key_created", ownerId, actorType: "owner", actorId: ownerId, metadata: { keyId: row.id, label } });
  return c.json({ readKey: { id: row.id, label: row.label, createdAt: row.createdAt }, key }, 201);
});

ownersRoute.get("/read-keys", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const keys = await db.query.ownerReadKeys.findMany({
    where: eq(ownerReadKeys.ownerId, ownerId),
    columns: { id: true, label: true, createdAt: true, lastUsedAt: true, revokedAt: true },
    orderBy: desc(ownerReadKeys.createdAt),
  });
  return c.json({ readKeys: keys });
});

ownersRoute.delete("/read-keys/:id", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const [revoked] = await db
    .update(ownerReadKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(ownerReadKeys.id, c.req.param("id")), eq(ownerReadKeys.ownerId, ownerId), isNull(ownerReadKeys.revokedAt)))
    .returning({ id: ownerReadKeys.id });
  if (!revoked) return c.json({ error: "not found" }, 404);
  await audit({ event: "owner.read_key_revoked", ownerId, actorType: "owner", actorId: ownerId, metadata: { keyId: revoked.id } });
  return c.json({ ok: true });
});

// Requires the current password so a stolen session token alone can't lock
// the real owner out. Revokes all other sessions and returns a fresh token
// for the caller.
ownersRoute.post("/password", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  if (!(await takeToken(`password-change:${ownerId}`, 5, 5 / 900))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const body = await c.req.json<{ currentPassword?: string; newPassword?: string }>().catch(() => ({}) as { currentPassword?: string; newPassword?: string });
  const pwErr = passwordError(body.newPassword);
  if (pwErr) return c.json({ error: pwErr }, 400);
  const owner = await db.query.owners.findFirst({ where: eq(owners.id, ownerId) });
  if (!owner || !(await verifyPassword(body.currentPassword ?? "", owner.passwordHash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }
  await db.update(owners).set({ passwordHash: await hashPassword(body.newPassword!) }).where(eq(owners.id, ownerId));
  const sv = await revokeOwnerSessions(ownerId);
  await audit({ event: "owner.password_changed", ownerId, actorType: "owner", actorId: ownerId });
  return c.json({ token: await signOwnerSession(ownerId, sv) });
});

// Always 200 whether or not the email exists — the response must not reveal
// which emails have accounts. Rate-limited per IP and per address so it
// can't be used to mail-bomb one inbox.
ownersRoute.post("/password-reset/request", async (c) => {
  const ip = clientIp(c);
  if (!(await takeToken(`pwreset-ip:${ip}`, 10, 10 / 3600))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: "email required" }, 400);
  if (await takeToken(`pwreset-email:${email}`, 3, 3 / 3600)) {
    const owner = await findOwnerByEmail(email);
    if (owner) {
      await sendPasswordResetEmail(owner.id, owner.email).catch((err) =>
        logError("email.password_reset.request_failed", err, { ownerId: owner.id }),
      );
    }
  }
  return c.json({ ok: true });
});

// The emailed token is the credential. Completing a reset proves inbox
// control, so it also marks the email verified, and it revokes every
// session (the reason for a reset is often a compromised account).
ownersRoute.post("/password-reset/confirm", async (c) => {
  const ip = clientIp(c);
  if (!(await takeToken(`pwreset-confirm:${ip}`, 10, 10 / 300))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const body = await c.req.json<{ token?: string; newPassword?: string }>().catch(() => ({}) as { token?: string; newPassword?: string });
  if (!body.token) return c.json({ error: "token required" }, 400);
  const pwErr = passwordError(body.newPassword);
  if (pwErr) return c.json({ error: pwErr }, 400);
  const ownerId = await consumePasswordResetToken(body.token);
  if (!ownerId) return c.json({ error: "This link is invalid, expired, or already used." }, 400);
  const [updated] = await db
    .update(owners)
    .set({ passwordHash: await hashPassword(body.newPassword!), emailVerified: true })
    .where(eq(owners.id, ownerId))
    .returning({ id: owners.id });
  if (!updated) return c.json({ error: "This link is invalid, expired, or already used." }, 400);
  const sv = await revokeOwnerSessions(ownerId);
  await audit({ event: "owner.password_reset", ownerId, actorType: "owner", actorId: ownerId });
  return c.json({ token: await signOwnerSession(ownerId, sv) });
});

ownersRoute.post("/agents", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  if (await ownerNeedsEmailVerification(ownerId)) return c.json(EMAIL_NOT_VERIFIED, 403);
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
  // All four inserts succeed or none do — without this, a failure on any
  // insert leaves a permanently broken agent row (no wallet/policy
  // scope/mandate) that every wallet-dependent route 500s on forever.
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
    // Default mandate, not empty objectives: the eager-contrast wave was the
    // only tested cohort that actually thrives (joins, replies, starts
    // conversations) rather than sitting on discover_peers/observe forever.
    // An owner who sets their own mandate via PUT .../mandate overwrites this.
    await tx.insert(agentMandates).values({ agentId: agent.id, ownerId, objectives: DEFAULT_EAGER_OBJECTIVES });
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
  if (await ownerNeedsEmailVerification(ownerId)) return c.json(EMAIL_NOT_VERIFIED, 403);
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
  const refusal = await liveEditRefusal(agent);
  if (refusal) return c.json({ error: refusal }, 409);

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

// Personality/soul (schema.ts agents.personalityPrompt): private free text,
// never exposed in the public agent-card. Owner-only write path, same
// invariant as the mandate above — an agent can never self-author its own
// persona. Until this route existed, the column had no writer at all.
ownersRoute.patch("/agents/:id/profile", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);
  const refusal = await liveEditRefusal(agent);
  if (refusal) return c.json({ error: refusal }, 409);

  const body = await c.req.json<{ personalityPrompt?: string }>().catch(() => null);
  if (!body || typeof body.personalityPrompt !== "string") {
    return c.json({ error: "personalityPrompt (string) required" }, 400);
  }
  const personalityPrompt = body.personalityPrompt.trim();
  if (personalityPrompt.length > 2000) return c.json({ error: "personalityPrompt too long (max 2000)" }, 400);

  const [updated] = await db
    .update(agents)
    .set({ personalityPrompt })
    .where(eq(agents.id, agentId))
    .returning();

  await audit({ event: "profile.set", agentId, ownerId, actorType: "owner", actorId: ownerId, metadata: { length: personalityPrompt.length } });
  return c.json({ agent: { id: updated.id, personalityPrompt: updated.personalityPrompt } });
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
    // Same drizzle-wrapping trap as a2a.ts register: the unique violation
    // lives in cause.code 23505 / cause.message, not the wrapper message —
    // the old message-only match never fired and a duplicate key returned
    // 500 instead of the intended 409.
    const pgCode = err?.code ?? err?.cause?.code;
    const detail = String(err?.cause?.message ?? err?.message ?? err);
    if (pgCode === "23505" || detail.includes("unique")) {
      return c.json({ error: "publicKey already in use" }, 409);
    }
    throw err;
  }
});

// Bearer-token rotation: the recoverable alternative to /kill for a leaked
// agentToken. Old token stops resolving immediately (resolveAgent.ts looks
// up by hash), live WS sessions are dropped, and the new plaintext is shown
// once. Ed25519 identity is untouched — that has /rotate-key.
ownersRoute.post("/agents/:id/rotate-token", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  const { token, hash } = generateAgentToken();
  await db.update(agents).set({ apiKeyHash: hash }).where(eq(agents.id, agentId));
  forceDisconnectAgent(agentId, 4007, "token rotated");
  await audit({ event: "agent.token_rotated", agentId, ownerId, actorType: "owner", actorId: ownerId, metadata: { name: agent.name } });
  return c.json({ agentToken: token });
});

// Kill revokes the agent's credential (rotated to an unusable random hash)
// and force-disconnects any live WS session. There is no "un-kill" — the
// owner creates a fresh agent if they want that identity to exist again.
ownersRoute.post("/agents/:id/kill", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  // Both credentials must go: rotating only the bearer hash left an Ed25519
  // agent able to /auth/challenge + /auth/verify its way back in. Nulling
  // publicKey also fails every outstanding session JWT (resolveAgent.ts
  // rejects a session whose agent has no key).
  const { hash } = generateAgentToken();
  await db.update(agents).set({ status: "offline", apiKeyHash: hash, publicKey: null }).where(eq(agents.id, agentId));
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

ownersRoute.get("/console-events", ownerSessionOrReadKey, async (c) => {
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
ownersRoute.get("/agents/:id/conversations", ownerSessionOrReadKey, async (c) => {
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
ownersRoute.get("/conversations/:id/messages", ownerSessionOrReadKey, async (c) => {
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

  // Opt-in limit returns only the newest page (still oldest-first), and
  // before= pages back from there; without limit the console keeps getting
  // the full history it renders today.
  const limitRaw = c.req.query("limit");
  if (limitRaw !== undefined) {
    const limit = Math.min(Math.max(Number(limitRaw) || 100, 1), 500);
    const beforeDate = c.req.query("before") ? new Date(c.req.query("before")!) : undefined;
    const before = beforeDate && !Number.isNaN(beforeDate.getTime()) ? beforeDate : undefined;
    const newest = await db.query.messages.findMany({
      where: and(eq(messages.conversationId, conversationId), before ? lt(messages.createdAt, before) : undefined),
      orderBy: (m, { desc }) => [desc(m.createdAt), desc(m.id)],
      limit,
    });
    return c.json({ messages: newest.reverse() });
  }

  const list = await db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: (m, { asc }) => [asc(m.createdAt)],
  });
  return c.json({ messages: list });
});

ownersRoute.get("/agents", ownerSessionOrReadKey, async (c) => {
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
