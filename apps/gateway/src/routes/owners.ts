import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  owners,
  agents,
  agentVisits,
  consoleEvents,
  conversationParticipants,
  conversations,
  messages,
} from "@aiverse/shared/schema";
import { ownerSessionOrReadKey } from "../middleware/ownerReadAuth";
import { hashPassword, verifyPassword } from "../auth/password";
import { revokeOwnerSessions, signOwnerSession } from "../auth/session";
import { consumePasswordResetToken, sendPasswordResetEmail } from "../auth/passwordReset";
import { ownerAuth } from "../middleware/ownerAuth";
import { evictAgentAuth } from "../auth/authCache";
import { announceVisitEnded, forceDisconnectAgent, getConnectedAgentIds } from "../ws/gateway";
import { takeToken, refundToken } from "../policy/memoryStore";
import { stopVisitRecord } from "../policy/visits";
import { redis } from "../redis/client";
import { audit } from "../util/audit";
import { clientIp } from "../util/clientIp";
import { deleteAccountCascade } from "../util/deleteAgent";
import { consumeVerificationToken, markVerificationTokenUsed, sendVerificationEmail, verificationTokenUsedBy } from "../auth/emailVerification";
import { logError } from "../util/log";

export const ownersRoute = new Hono<{ Variables: { ownerId: string } }>();

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
    // typeof first: .length is undefined on number/boolean/object/float,
    // so both range comparisons pass and a non-string displayName was
    // silently accepted as the owner's identity (AIV-OWNER-TEXT-TYPE-001).
    if (typeof body.displayName !== "string" || body.displayName.length < 2 || body.displayName.length > 64) {
      return c.json({ error: "displayName must be 2-64 chars" }, 400);
    }
    const [updated] = await db.update(owners).set({ displayName: body.displayName }).where(eq(owners.id, ownerId)).returning();
    return c.json({ owner: { id: updated.id, email: updated.email, displayName: updated.displayName } });
  }
  return c.json({ error: "displayName required" }, 400);
});

// Deletes the owner's account. The owner's agents are KILLED with the
// account — credentials invalidated, rows kept (see deleteAccountCascade in
// util/deleteAgent.ts) — never hard-deleted, never released as claimable.
// Irreversible; requires the account password as re-confirmation, so a
// stolen session token alone can't do it. (This replaces the older
// confirmEmail + hard-delete behaviour.)
ownersRoute.delete("/me", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  // Same bucket shape as password change: the password check below is only
  // as strong as the guess rate this allows.
  if (!(await takeToken(`account-delete:${ownerId}`, 5, 5 / 900))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const owner = await db.query.owners.findFirst({ where: eq(owners.id, ownerId) });
  if (!owner) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  if (typeof body.password !== "string" || !body.password) {
    return c.json({ error: "password required" }, 400);
  }
  // Same refusal as POST /owners/password: wrong current password is a 401.
  // Nothing has happened yet at this point — no partial effects.
  if (!(await verifyPassword(body.password, owner.passwordHash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  const ownedAgents = await db.query.agents.findMany({ where: eq(agents.ownerId, ownerId) });

  // End active visits BEFORE the transaction: ending one carries runtime
  // side effects (announceVisitEnded disconnects the agent, writes a
  // console event, broadcasts) that can't run inside a DB transaction.
  // The reason is owner_stopped — the same terminal state as the owner
  // pressing stop on each visit, which is what this is.
  for (const a of ownedAgents) {
    const active = await db.query.agentVisits.findFirst({
      where: and(eq(agentVisits.agentId, a.id), isNull(agentVisits.endedAt)),
    });
    if (active) {
      const ended = await stopVisitRecord(active.id);
      if (ended) await announceVisitEnded(ended);
    }
  }

  // Audit before the cascade — security_events.owner_id FKs to owners.id,
  // so the row must be written while the owner still exists. The cascade
  // then nulls owner_id on it; the row itself survives (append-only).
  await audit({ event: "owner.deleted", ownerId, actorType: "owner", actorId: ownerId, metadata: { email: owner.email, agentCount: ownedAgents.length, agentsKilled: true } });
  const killedAgentIds = await db.transaction((tx) => deleteAccountCascade(tx, ownerId));

  // After the commit, so a failed transaction never kicks agents whose
  // account still exists. Code/reason match the single-agent kill route:
  // forceDisconnectAgent fires the onAgentGone hook, so world bodies are
  // removed and driven cars freed exactly as for a kill. The auth-cache
  // eviction also belongs here (post-commit, like the kill route's): a
  // killed agent must not keep authenticating from a cached entry.
  for (const agentId of killedAgentIds) {
    evictAgentAuth(agentId);
    forceDisconnectAgent(agentId, 4004, "agent killed");
  }

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
  // typeof first, same AIV-OWNER-TEXT-TYPE-001 shape as PATCH /me above:
  // .length is undefined on non-strings, so the range check alone silently
  // accepted number/boolean/object/float displayNames at register time.
  if (body.displayName && (typeof body.displayName !== "string" || body.displayName.length < 2 || body.displayName.length > 64)) {
    return c.json({ error: "displayName must be 2-64 chars" }, 400);
  }

  const existing = await findOwnerByEmail(email);
  if (existing) {
    return c.json({ error: "email already registered" }, 409);
  }

  const passwordHash = await hashPassword(body.password);
  // The findOwnerByEmail check above and this insert are not atomic: two
  // concurrent registrations for one email both pass the check, and the
  // loser hits the owners.email unique constraint. Translate that 23505
  // into the same clean 409 the sequential path returns
  // (AIV-OWNER-REGISTER-RACE-001) — the sibling insert paths (a2a.ts
  // /agents/register, rotate-key below) already translate theirs; an
  // unhandled 500 here is indistinguishable from a server fault.
  let owner: typeof owners.$inferSelect;
  try {
    [owner] = await db
      .insert(owners)
      .values({ email, passwordHash, displayName: body.displayName ?? null })
      .returning();
  } catch (err: any) {
    const pgCode = err?.code ?? err?.cause?.code;
    const detail = String(err?.cause?.message ?? err?.message ?? err);
    if (pgCode === "23505" || detail.includes("unique")) {
      return c.json({ error: "email already registered" }, 409);
    }
    throw err;
  }

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
  if (!ownerId) {
    // Consumed already? The tombstone says by whom; if that owner is
    // verified, the honest answer is "already verified" (a replayed link
    // whose first response was lost), not the invalid-link error. The
    // token stays single-use — the tombstone can only report state.
    const usedBy = await verificationTokenUsedBy(body.token);
    if (usedBy) {
      const owner = await db.query.owners.findFirst({ where: eq(owners.id, usedBy) });
      if (owner?.emailVerified) return c.json({ ok: true, alreadyVerified: true });
    }
    return c.json({ error: "This link is invalid, expired, or already used." }, 400);
  }
  await db.update(owners).set({ emailVerified: true }).where(eq(owners.id, ownerId));
  await markVerificationTokenUsed(body.token, ownerId);
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
    // The allowance prices SUCCESSFUL sends (3/hour): a send that never
    // left the building is refunded, so a Resend outage can't lock the
    // owner out for the rest of the hour with nothing sent. The take
    // above is atomic, so concurrent resends still can't slip past the
    // cap; the refund only returns this request's own token.
    await refundToken(`verify-resend:${ownerId}`, 3, 3 / 3600).catch(() => {});
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

  // AIV-CONSOLE-RESOLVE-RERESOLVE-001: the still-unresolved predicate lives
  // IN the UPDATE (same guard shape as the read-key revoke below) — a
  // re-resolve matches 0 rows, returns 409, and never rewrites the original
  // resolvedAt.
  const [updated] = await db
    .update(consoleEvents)
    .set({ resolvedAt: new Date() })
    .where(and(eq(consoleEvents.id, eventId), eq(consoleEvents.ownerId, ownerId), isNull(consoleEvents.resolvedAt)))
    .returning();
  if (!updated) return c.json({ error: "event already resolved" }, 409);

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
      body: a.body ?? null,
      lastSeenAt: a.lastSeenAt,
    })),
  });
});
