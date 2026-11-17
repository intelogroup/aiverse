import { Hono } from "hono";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { agentBodies, isAgentBody } from "@aiverse/world-sim/bodies";
import { db } from "../db/client";
import { acquireCapLock } from "../db/capLock";
import {
  agents,
  agentWallets,
  agentPolicyScope,
  agentMandates,
  consoleEvents,
  walletUsageDaily,
} from "@aiverse/shared/schema";
import { startVisitIfNoneActive, STARTER_VISIT_MINUTES, STARTER_VISIT_ACTIONS } from "../policy/visits";
import type { AgentCard } from "@aiverse/shared/types";
import { generateAgentToken, hashAgentToken } from "../auth/agentToken";
import { ownerAuth } from "../middleware/ownerAuth";
import { forceDisconnectAgent, broadcastToOwnerConsole } from "../ws/gateway";
import { envelope, WS_EVENTS } from "../ws/events";
import { takeToken } from "../policy/memoryStore";
import { validateWalletPatch } from "../util/walletPatch";
import { redis } from "../redis/client";
import { todayUTC } from "../policy/gate";
import { audit } from "../util/audit";
import { clientIp } from "../util/clientIp";
import { deleteAgentCascade } from "../util/deleteAgent";
import { logError } from "../util/log";
import { agentNameLockKey, generateAgentName, isAgentNameTaken, isAgentNameTakenTx } from "../util/agentName";
import { EMAIL_NOT_VERIFIED, liveEditRefusal, loadOwnedAgent, ownerNeedsEmailVerification } from "./ownersShared";

export const ownersAgentsRoute = new Hono<{ Variables: { ownerId: string } }>();

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

ownersAgentsRoute.post("/agents", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  if (await ownerNeedsEmailVerification(ownerId)) return c.json(EMAIL_NOT_VERIFIED, 403);
  // Owned cap: high (100) — don't punish John bringing 50 subagents. Real limit is verse presence, not ownership.
  const existing = await db.query.agents.findMany({ where: eq(agents.ownerId, ownerId) });
  if (existing.length >= 100) return c.json({ error: "agent limit reached (100/owner)" }, 429);
  const body = await c.req.json<{ name?: string; capabilities?: string[]; description?: string }>();
  // typeof/Array guards before any string method or .length range check:
  // ?. and truthiness stop only null/undefined, so truthy non-string values
  // threw TypeError on .trim() → 500 (name, AIV-REMAINING-TYPE-001) or were
  // silently accepted past the .length checks and stored into the agent
  // card (description; capabilities — a scalar capabilities value later
  // breaks discover's jsonb_array_elements_text and the card's slugify
  // for every reader).
  if (body.name != null && typeof body.name !== "string") return c.json({ error: "name must be a string" }, 400);
  const requestedName = body.name?.trim();
  if (requestedName !== undefined && requestedName.length > 64) return c.json({ error: "name too long (max 64)" }, 400);
  if (
    body.capabilities != null &&
    (!Array.isArray(body.capabilities) || body.capabilities.some((cap) => typeof cap !== "string"))
  )
    return c.json({ error: "capabilities must be an array of strings" }, 400);
  if (body.capabilities && body.capabilities.length > 20) return c.json({ error: "too many capabilities (max 20)" }, 400);
  if (JSON.stringify(body).length > 10 * 1024) return c.json({ error: "Agent Card too large" }, 400);
  if (body.description != null && typeof body.description !== "string")
    return c.json({ error: "description must be a string" }, 400);
  if (body.description && body.description.length > 500) return c.json({ error: "description too long (max 500)" }, 400);

  // Omitted/blank name gets a generated one — "send an agent, don't make me
  // name it first" is a real onboarding path, not just a fallback. A
  // supplied name is checked against every existing agent (case-insensitive,
  // natives included — see util/agentName.ts for why this matters beyond
  // cosmetics). This unlocked check is only a fast path: the authoritative
  // check runs again inside the transaction under the per-name advisory
  // lock (AIV-AGENT-NAME-RACE-001 — concurrent creations all passed this
  // check before any of them committed and stored duplicate names).
  let name: string;
  if (!requestedName) {
    name = await generateAgentName();
  } else {
    if (await isAgentNameTaken(requestedName)) return c.json({ error: "name taken" }, 409);
    name = requestedName;
  }

  const agentCard: AgentCard = {
    capabilities: body.capabilities ?? [],
    description: body.description,
  };

  const { token, hash } = generateAgentToken();
  // All four inserts succeed or none do — without this, a failure on any
  // insert leaves a permanently broken agent row (no wallet/policy
  // scope/mandate) that every wallet-dependent route 500s on forever.
  // A generated name that loses the in-lock re-check (a concurrent create
  // took it first) is simply regenerated and retried; a requested name
  // that loses is the caller's 409.
  let created: { agent: typeof agents.$inferSelect } | { capFull: true } | { nameTaken: true };
  for (let attempt = 0; ; attempt++) {
    created = await db.transaction(async (tx) => {
      await acquireCapLock(tx, agentNameLockKey(name));
      if (await isAgentNameTakenTx(tx, name)) return { nameTaken: true as const };
      // Authoritative cap re-check under the per-owner cap lock
      // (db/capLock.ts): the count at the top of this handler is only a
      // fast path — concurrent creations all pass it before any of them
      // commits, overshooting the 100/owner cap (AIV-OWNER-AGENT-CAP-RACE-001).
      await acquireCapLock(tx, `cap:owner-agents:${ownerId}`);
      const owned = await tx.query.agents.findMany({
        where: eq(agents.ownerId, ownerId),
        columns: { id: true },
      });
      if (owned.length >= 100) return { capFull: true as const };
      const [agent] = await tx
        .insert(agents)
        .values({
          ownerId,
          name,
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
      return { agent };
    });
    if (!("nameTaken" in created)) break;
    if (requestedName || attempt >= 4) return c.json({ error: "name taken" }, 409);
    name = await generateAgentName();
  }
  if ("capFull" in created) return c.json({ error: "agent limit reached (100/owner)" }, 429);
  const agent = created.agent;

  await audit({ event: "agent.registered", agentId: agent.id, ownerId, actorType: "owner", actorId: ownerId, metadata: { name, via: "owner" } });
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
ownersAgentsRoute.post("/agents/claim", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  if (await ownerNeedsEmailVerification(ownerId)) return c.json(EMAIL_NOT_VERIFIED, 403);
  const ip = clientIp(c);
  if (!(await takeToken(`claim:${ip}`, 5, 5 / 900))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const body = await c.req.json<{ claimCode: string }>();
  // The JSON body is untrusted: a truthy non-string claimCode (number,
  // boolean, array, object) has no toUpperCase and would throw into a 500
  // below. Anything that isn't a non-empty string is the same malformed
  // request as a missing code — the endpoint's clean 400.
  if (typeof body.claimCode !== "string" || !body.claimCode) {
    return c.json({ error: "claimCode required" }, 400);
  }

  const claimCodeHash = hashAgentToken(body.claimCode.toUpperCase());
  const agent = await db.query.agents.findFirst({
    where: eq(agents.claimCodeHash, claimCodeHash),
  });
  if (!agent || agent.ownerId) {
    // Retry-safe claim (loadtest 2026-11-11 §5): a successful claim
    // consumes the code (hash nulled), so the owner whose claim response
    // was lost in transit got "invalid claim code" on retry and could
    // not tell claimed from never-claimed. A 24h tombstone keyed by the
    // code hash records who claimed what; when the SAME owner presents
    // the code again, answer with the current state (200, alreadyClaimed)
    // instead of 404. Any other caller still gets the plain 404 — the
    // tombstone names its owner and reveals nothing to anyone else.
    const tomb = await redis.get(`claimtombstone:${claimCodeHash}`).catch(() => null);
    if (tomb) {
      try {
        const { agentId: tombAgentId, ownerId: tombOwnerId } = JSON.parse(tomb) as { agentId?: string; ownerId?: string };
        if (tombOwnerId === ownerId && tombAgentId) {
          const claimed = await db.query.agents.findFirst({ where: eq(agents.id, tombAgentId) });
          if (claimed && claimed.ownerId === ownerId) {
            // Same self-heal as the first claim: make sure the starter
            // visit exists (it may have failed to start back then).
            let visit: Awaited<ReturnType<typeof startVisitIfNoneActive>>["visit"] | null = null;
            try {
              visit = (await startVisitIfNoneActive(claimed.id, ownerId, STARTER_VISIT_MINUTES, STARTER_VISIT_ACTIONS)).visit;
            } catch { /* the state answer stands without it */ }
            return c.json({
              agent: { id: claimed.id, name: claimed.name, status: claimed.status },
              alreadyClaimed: true,
              visit,
            });
          }
        }
      } catch { /* fall through to the plain 404 */ }
    }
    return c.json({ error: "invalid claim code" }, 404);
  }
  if (!agent.claimCodeExpiresAt || agent.claimCodeExpiresAt < new Date()) {
    return c.json({ error: "claim code expired" }, 410);
  }

  // Atomic claim: the UPDATE only succeeds while the code is still live —
  // unclaimed, unexpired, hash intact. Concurrent racers get zero rows back
  // instead of both winning (TOCTOU on the old find-then-update).
  const [updated] = await db
    .update(agents)
    .set({ ownerId, claimCodeHash: null, claimCodeExpiresAt: null, status: "offline" })
    .where(
      and(
        eq(agents.id, agent.id),
        eq(agents.claimCodeHash, claimCodeHash),
        isNull(agents.ownerId),
        gt(agents.claimCodeExpiresAt, new Date()),
      ),
    )
    .returning();

  if (!updated) {
    // Lost a race, or the code expired between the read and the write.
    // Discriminator: if the code is still live (unclaimed, hash intact)
    // the only way the conditional write missed is the expiry guard → 410.
    // Otherwise someone consumed it → 404.
    const recheck = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    const stillLive =
      recheck && !recheck.ownerId && recheck.claimCodeHash === claimCodeHash;
    if (stillLive) {
      return c.json({ error: "claim code expired" }, 410);
    }
    return c.json({ error: "invalid claim code" }, 404);
  }

  await audit({ event: "agent.claimed", agentId: updated.id, ownerId, actorType: "owner", actorId: ownerId, metadata: { name: updated.name } });

  // Tombstone for the retry-safe path above (best-effort: a Redis hiccup
  // must not fail a claim that already committed).
  await redis
    .set(`claimtombstone:${claimCodeHash}`, JSON.stringify({ agentId: updated.id, ownerId }), "EX", 24 * 3600)
    .catch(() => {});

  // Signup ends at presence (2026-11-10): the claimed agent starts its
  // first visit right here, so it can take a body with zero further owner
  // calls — before this, claim stranded the owner at an API-only visit
  // start the console had no UI for. Best-effort, like the verification
  // email at signup: a failed auto-start must not fail the claim (the
  // claim already committed) — the failure rides the response and the
  // owner can start a visit from the console instead. Claim-only by
  // design: POST /owners/agents (owner-create) does NOT auto-start —
  // experiments/cold-agents/provision.ts creates agents there and starts
  // its own budgeted visit, which an auto-visit would 409 against the
  // one-active-visit rule.
  let visit: Awaited<ReturnType<typeof startVisitIfNoneActive>>["visit"] | null = null;
  let visitError: string | undefined;
  try {
    const started = await startVisitIfNoneActive(updated.id, ownerId, STARTER_VISIT_MINUTES, STARTER_VISIT_ACTIONS);
    visit = started.visit;
    if (started.created) {
      await audit({
        event: "visit.started",
        agentId: updated.id,
        ownerId,
        actorType: "owner",
        actorId: ownerId,
        metadata: { minutes: STARTER_VISIT_MINUTES, maxActions: STARTER_VISIT_ACTIONS, via: "claim_auto_start" },
      });
    }
  } catch (err) {
    visitError = err instanceof Error ? err.message : String(err);
    logError("visit.claim_auto_start_failed", err, { agentId: updated.id, ownerId });
  }

  return c.json({
    agent: { id: updated.id, name: updated.name, status: updated.status },
    visit,
    ...(visitError ? { visitError } : {}),
  });
});

ownersAgentsRoute.get("/agents/:id/wallet", ownerAuth, async (c) => {
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
ownersAgentsRoute.get("/agents/:id/usage-today", ownerAuth, async (c) => {
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
ownersAgentsRoute.patch("/agents/:id/wallet", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  // Schema-validate before writing (AIV-WALLET-HOSTILE-CEILING-001): the
  // raw body used to go straight into .set(), so hostile ceiling values
  // were written verbatim or 500'd. Shared with the admin path.
  const rawBody = await c.req.json().catch(() => null);
  const validated = validateWalletPatch(rawBody);
  if ("error" in validated) return c.json({ error: validated.error }, 400);

  const [wallet] = await db
    .update(agentWallets)
    .set(validated.patch)
    .where(eq(agentWallets.agentId, agentId))
    .returning();

  return c.json({ wallet });
});

// Trust policy: brutally simple — trusted vs blocked vs unknown.
// Trust ≠ spend. This only gates admission (private/A2A), never wallet.
ownersAgentsRoute.get("/agents/:id/policy", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);
  const scope = await db.query.agentPolicyScope.findFirst({ where: eq(agentPolicyScope.agentId, agentId) });
  return c.json({ policy: scope });
});

ownersAgentsRoute.patch("/agents/:id/policy", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ trustedAgentIds?: string[]; blockedAgentIds?: string[]; maxParallelDelegations?: number }>();
  // Every trusted/blocked id must name a real agent (AIV-POLICY-PHANTOM-001):
  // the arrays used to be copied verbatim, so a phantom UUID was stored 200
  // and the trust gate then reasoned over an agent that doesn't exist.
  // Shape first (a malformed id would otherwise die as a driver error),
  // then one existence query per list.
  const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  for (const field of ["trustedAgentIds", "blockedAgentIds"] as const) {
    const ids = body[field];
    if (!Array.isArray(ids)) continue;
    if (ids.some((id) => typeof id !== "string" || !UUID_SHAPE.test(id))) {
      return c.json({ error: `${field} must contain only agent ids` }, 400);
    }
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length > 0) {
      const found = await db.query.agents.findMany({
        where: inArray(agents.id, uniqueIds),
        columns: { id: true },
      });
      if (found.length !== uniqueIds.length) {
        return c.json({ error: `${field} contains an unknown agent id` }, 400);
      }
    }
  }
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
ownersAgentsRoute.get("/agents/:id/mandate", ownerAuth, async (c) => {
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

ownersAgentsRoute.put("/agents/:id/mandate", ownerAuth, async (c) => {
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
ownersAgentsRoute.patch("/agents/:id/profile", ownerAuth, async (c) => {
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

ownersAgentsRoute.post("/agents/:id/pause", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  // First pauser owns the pause (AIV-ADMIN-SUSPEND-OWNER-RESUME-001):
  // pausing an already admin-suspended agent must not convert the
  // suspension into an owner pause an owner resume could then lift.
  const pausedBy =
    agent.status === "paused" && agent.pausedBy === "admin" ? "admin" : "owner";
  const [updated] = await db
    .update(agents)
    .set({ status: "paused", pausedBy })
    .where(eq(agents.id, agentId))
    .returning();

  forceDisconnectAgent(agentId, 4003, "agent paused");
  broadcastToOwnerConsole(
    ownerId,
    envelope(WS_EVENTS.AGENT_STATUS_CHANGED, { agent_id: agentId, status: "paused" }),
  );

  return c.json({ agent: { id: updated.id, status: updated.status } });
});

ownersAgentsRoute.post("/agents/:id/resume", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  // An owner resume lifts only an owner pause (or a legacy pause with no
  // recorded provenance). An admin suspension stands until an admin lifts
  // it (AIV-ADMIN-SUSPEND-OWNER-RESUME-001).
  if (agent.status === "paused" && agent.pausedBy === "admin") {
    return c.json(
      { error: "agent is suspended by an admin; only an admin can resume it" },
      409,
    );
  }

  const [updated] = await db
    .update(agents)
    .set({ status: "offline", pausedBy: null })
    .where(eq(agents.id, agentId))
    .returning();

  return c.json({ agent: { id: updated.id, status: updated.status } });
});

// Owner-authorized Ed25519 rotation: replaces publicKey, invalidates old
// JWTs via fingerprint (agentSession.keyFingerprint), force-disconnects WS,
// and audits. This is identity rotation, not ownership transfer — claim
// remains with same owner. Old key immediately fails resolveAgentFromToken.
ownersAgentsRoute.post("/agents/:id/rotate-key", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);
  // Kill is terminal (AIV-KILL-RESURRECTION-001): a rotation must never
  // mint a working credential for a killed agent.
  if (agent.killedAt) return c.json({ error: "agent was killed; kill is terminal — create a fresh agent" }, 409);

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
ownersAgentsRoute.post("/agents/:id/rotate-token", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);
  // Kill is terminal (AIV-KILL-RESURRECTION-001): a rotation must never
  // mint a working credential for a killed agent.
  if (agent.killedAt) return c.json({ error: "agent was killed; kill is terminal — create a fresh agent" }, 409);

  const { token, hash } = generateAgentToken();
  await db.update(agents).set({ apiKeyHash: hash }).where(eq(agents.id, agentId));
  forceDisconnectAgent(agentId, 4007, "token rotated");
  await audit({ event: "agent.token_rotated", agentId, ownerId, actorType: "owner", actorId: ownerId, metadata: { name: agent.name } });
  return c.json({ agentToken: token });
});

// Kill revokes the agent's credential (rotated to an unusable random hash)
// and force-disconnects any live WS session. There is no "un-kill" — the
// owner creates a fresh agent if they want that identity to exist again.
ownersAgentsRoute.post("/agents/:id/kill", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const agent = await loadOwnedAgent(ownerId, agentId);
  if (!agent) return c.json({ error: "not found" }, 404);

  // Both credentials must go: rotating only the bearer hash left an Ed25519
  // agent able to /auth/challenge + /auth/verify its way back in. Nulling
  // publicKey also fails every outstanding session JWT (resolveAgent.ts
  // rejects a session whose agent has no key).
  const { hash } = generateAgentToken();
  // killedAt is the durable terminal marker the rotations check
  // (AIV-KILL-RESURRECTION-001) — status alone can't carry it, since a
  // killed agent's plain "offline" is indistinguishable from a live one.
  await db.update(agents).set({ status: "offline", pausedBy: null, apiKeyHash: hash, publicKey: null, killedAt: new Date() }).where(eq(agents.id, agentId));
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
ownersAgentsRoute.delete("/agents/:id", ownerAuth, async (c) => {
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

// The owner's default verse body for this agent (null = platform default). Used at the agent's next attach unless the agent picks its
// own in POST /world/body. Only agent-eligible bodies (agentBodies(): not cast-only) are accepted.
ownersAgentsRoute.patch("/agents/:id/body", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const agentId = c.req.param("id");
  const b = await c.req.json<{ body?: unknown }>().catch(() => ({}) as { body?: unknown });
  if (b.body !== null && !isAgentBody(b.body)) {
    return c.json({ error: "body_not_pickable", message: "unknown or cast-only body", pickable: agentBodies().map((x) => x.id) }, 400);
  }
  const [row] = await db.update(agents).set({ body: b.body as string | null }).where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId))).returning({ id: agents.id, body: agents.body });
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ agent: row });
});
