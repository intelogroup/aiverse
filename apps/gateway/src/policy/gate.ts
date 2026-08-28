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
import { agentPolicyScope } from "@aiverse/shared/schema";
import { eq } from "drizzle-orm";
import type { AutonomyMode } from "./types";

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

// Phase 2 hardcoded default; Phase 3 replaces this with the agent's real
// wallet.max_simultaneous_conversations value.
const DEFAULT_MAX_SIMULTANEOUS_CONVERSATIONS = 20;

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
