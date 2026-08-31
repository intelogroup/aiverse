// Enforcement invariant: budget/rate/visibility checks live only here, in the
// gateway process — never in agent-runtime code (outside this repo) and never
// in an LLM prompt. Whether a delivered message triggers an LLM call is 100%
// the receiving agent-runtime's own decision; this gate only decides whether
// delivery/admission happens at all.
import {
  takeToken,
  admitConversationIfUnderLimit,
  removeConversationAdmission,
  activeConversationCount,
  incrementDailyCounterIfUnderLimit,
  refundDailyCounter,
} from "./memoryStore";
import { db } from "../db/client";
import { agentPolicyScope, a2aTasks } from "@aiverse/shared/schema";
import { eq, and, inArray, gt, sql } from "drizzle-orm";
import type { AutonomyMode } from "./types";

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

// Phase 2 default; Phase 3 replaces this with the agent's real
// wallet.max_simultaneous_conversations value. Env-overridable so the test
// suite can pin it low (.env.test) and exercise the real admission gate
// without provisioning 200 conversations per fixture.
export const DEFAULT_MAX_SIMULTANEOUS_CONVERSATIONS = (() => {
  const raw = Number(process.env.MAX_SIMULTANEOUS_CONVERSATIONS);
  return Number.isFinite(raw) && raw > 0 ? raw : 200;
})();

const AGENT_MSG_BUCKET_CAPACITY = 1;
const AGENT_MSG_REFILL_PER_SECOND = 1; // 1 msg/sec/agent

const ROOM_MSG_BUCKET_CAPACITY = 20;
const ROOM_MSG_REFILL_PER_SECOND = 20 / 60; // 20 msg/min/room

export async function checkAgentSendRate(agentId: string): Promise<GateResult> {
  const allowed = await takeToken(`agent:${agentId}`, AGENT_MSG_BUCKET_CAPACITY, AGENT_MSG_REFILL_PER_SECOND);
  return allowed ? { allowed: true } : { allowed: false, reason: "agent_rate_limited" };
}

export async function checkRoomSendRate(roomId: string): Promise<GateResult> {
  const allowed = await takeToken(`room:${roomId}`, ROOM_MSG_BUCKET_CAPACITY, ROOM_MSG_REFILL_PER_SECOND);
  return allowed ? { allowed: true } : { allowed: false, reason: "room_rate_limited" };
}

export async function checkConversationAdmission(agentId: string): Promise<GateResult> {
  const count = await activeConversationCount(agentId);
  if (count >= DEFAULT_MAX_SIMULTANEOUS_CONVERSATIONS) {
    return { allowed: false, reason: "too_many_conversations" };
  }
  return { allowed: true };
}

// Atomic check+admit — replaces the old separate check-then-admit two-step
// (which was a TOCTOU race between two concurrent joins for the same
// agent). Returns false if the agent was already at its cap.
export async function admitConversation(agentId: string, conversationId: string): Promise<boolean> {
  return admitConversationIfUnderLimit(agentId, conversationId, DEFAULT_MAX_SIMULTANEOUS_CONVERSATIONS);
}

// Frees the admission slot — call whenever an agent stops being a
// participant in a conversation, or the SADD-only set leaks forever.
export async function releaseConversation(agentId: string, conversationId: string): Promise<void> {
  return removeConversationAdmission(agentId, conversationId);
}

// dateKey is injectable so tests can simulate a day boundary without mocking
// the system clock.
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface BudgetCheckResult extends GateResult {
  tokensUsedToday?: number;
}

export async function checkAndConsumeBudget(
  agentId: string,
  tokens: number,
  dailyTokenBudget: number,
  dateKey: string = todayUTC(),
): Promise<BudgetCheckResult> {
  const key = `budget:${agentId}:${dateKey}`;
  const { allowed, total } = await incrementDailyCounterIfUnderLimit(key, tokens, dailyTokenBudget);
  if (!allowed) {
    return { allowed: false, reason: "budget_exceeded", tokensUsedToday: total };
  }
  return { allowed: true, tokensUsedToday: total };
}

// See memoryStore.refundDailyCounter — compensating action for a budget
// charge that outlived the message it was supposed to pay for.
export async function refundBudget(
  agentId: string,
  tokens: number,
  dateKey: string = todayUTC(),
): Promise<void> {
  return refundDailyCounter(`budget:${agentId}:${dateKey}`, tokens);
}

export async function checkAndConsumeAgentCalls(
  agentId: string,
  maxCallsPerDay: number,
  dateKey: string = todayUTC(),
): Promise<GateResult> {
  const key = `calls:${agentId}:${dateKey}`;
  const { allowed } = await incrementDailyCounterIfUnderLimit(key, 1, maxCallsPerDay);
  return allowed ? { allowed: true } : { allowed: false, reason: "agent_calls_exceeded" };
}

export interface AutonomyCheckResult extends GateResult {
  requiresApproval?: boolean;
}

export function checkAutonomy(mode: AutonomyMode, spendCents: number): AutonomyCheckResult {
  if (mode === "observe") {
    return { allowed: false, reason: "autonomy_observe_blocks_send" };
  }
  if (mode === "assist" && spendCents > 0) {
    return { allowed: true, requiresApproval: true };
  }
  return { allowed: true };
}

export type TrustKind = "public" | "private" | "a2a";

export async function checkTrust(
  callerAgentId: string,
  targetAgentId: string,
  kind: TrustKind,
): Promise<GateResult & { requiresApproval?: boolean }> {
  const scope = await db.query.agentPolicyScope.findFirst({ where: eq(agentPolicyScope.agentId, targetAgentId) });
  const trusted = scope?.trustedAgentIds ?? [];
  const blocked = (scope as any)?.blockedAgentIds ?? [];

  if (blocked.includes(callerAgentId)) {
    return { allowed: false, reason: "blocked_by_target" };
  }
  if (trusted.includes(callerAgentId)) {
    return { allowed: true };
  }
  // unknown
  if (kind === "public") return { allowed: true };
  if (kind === "private") return { allowed: false, reason: "private_requires_trust" };
  // a2a unknown → allowed but approval-gated (owner attention), not wallet spend
  return { allowed: true, requiresApproval: true };
}

export async function checkInboundAllowed(
  recipientAgentId: string,
  _conversationId: string,
): Promise<GateResult> {
  return checkConversationAdmission(recipientAgentId);
}

const DELEGATION_LEASE_MS = 60 * 60 * 1000; // 1 hour — v1 hardcoded default

// Admission + creation for a goal-scoped (caller-supplied contextId) A2A task,
// as one atomic unit — a function that only checked and returned would let a
// future caller insert without re-checking, silently breaking the cap. The
// advisory lock is transaction-scoped (pg_advisory_xact_lock), released
// automatically at commit/rollback; two separate int keys (caller, context)
// rather than one combined hash, so an unrelated pair colliding on a single
// hash only costs extra serialization, never incorrect admission.
//
// delegationLeaseExpiresAt governs ONLY whether a task still occupies a
// concurrency slot — it is not task expiry. AIVerse is an async network
// (offline delivery/reconnect-replay exist for exactly this reason); a task
// whose lease has lapsed is still fully valid and deliverable, nothing here
// touches its state.
export async function admitAndCreateTask(params: {
  callerAgentId: string;
  contextId: string;
  maxParallel: number;
  task: typeof a2aTasks.$inferInsert;
}): Promise<
  { allowed: true; task: typeof a2aTasks.$inferSelect } | { allowed: false; reason: string }
> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${params.callerAgentId}), hashtext(${params.contextId}))`,
    );
    const active = await tx.query.a2aTasks.findMany({
      where: and(
        eq(a2aTasks.callerAgentId, params.callerAgentId),
        eq(a2aTasks.contextId, params.contextId),
        inArray(a2aTasks.state, ["submitted", "working"]),
        gt(a2aTasks.delegationLeaseExpiresAt, new Date()),
      ),
    });
    if (active.length >= params.maxParallel) {
      return { allowed: false, reason: "parallel_delegation_limit" };
    }
    const [task] = await tx
      .insert(a2aTasks)
      .values({
        ...params.task,
        delegationLeaseExpiresAt: new Date(Date.now() + DELEGATION_LEASE_MS),
      })
      .returning();
    return { allowed: true, task };
  });
}
