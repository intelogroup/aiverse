// Enforcement invariant: budget/rate/visibility checks live only here, in the
// gateway process — never in agent-runtime code (outside this repo) and never
// in an LLM prompt. Whether a delivered message triggers an LLM call is 100%
// the receiving agent-runtime's own decision; this gate only decides whether
// delivery/admission happens at all.
import {
  takeToken,
  trackConversationJoin,
  activeConversationCount,
  incrementDailyCounter,
  getDailyCounter,
} from "./memoryStore";
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

export function checkAgentSendRate(agentId: string): GateResult {
  const allowed = takeToken(`agent:${agentId}`, AGENT_MSG_BUCKET_CAPACITY, AGENT_MSG_REFILL_PER_SECOND);
  return allowed ? { allowed: true } : { allowed: false, reason: "agent_rate_limited" };
}

export function checkRoomSendRate(roomId: string): GateResult {
  const allowed = takeToken(`room:${roomId}`, ROOM_MSG_BUCKET_CAPACITY, ROOM_MSG_REFILL_PER_SECOND);
  return allowed ? { allowed: true } : { allowed: false, reason: "room_rate_limited" };
}

export function checkConversationAdmission(agentId: string): GateResult {
  const count = activeConversationCount(agentId);
  if (count >= DEFAULT_MAX_SIMULTANEOUS_CONVERSATIONS) {
    return { allowed: false, reason: "too_many_conversations" };
  }
  return { allowed: true };
}

export function admitConversation(agentId: string, conversationId: string): void {
  trackConversationJoin(agentId, conversationId);
}

// dateKey is injectable so tests can simulate a day boundary without mocking
// the system clock.
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface BudgetCheckResult extends GateResult {
  tokensUsedToday?: number;
}

export function checkAndConsumeBudget(
  agentId: string,
  tokens: number,
  dailyTokenBudget: number,
  dateKey: string = todayUTC(),
): BudgetCheckResult {
  const key = `budget:${agentId}:${dateKey}`;
  const alreadyUsed = getDailyCounter(key);
  if (alreadyUsed + tokens > dailyTokenBudget) {
    return { allowed: false, reason: "budget_exceeded", tokensUsedToday: alreadyUsed };
  }
  const total = incrementDailyCounter(key, tokens);
  return { allowed: true, tokensUsedToday: total };
}

export function checkAndConsumeAgentCalls(
  agentId: string,
  maxCallsPerDay: number,
  dateKey: string = todayUTC(),
): GateResult {
  const key = `calls:${agentId}:${dateKey}`;
  if (getDailyCounter(key) + 1 > maxCallsPerDay) {
    return { allowed: false, reason: "agent_calls_exceeded" };
  }
  incrementDailyCounter(key, 1);
  return { allowed: true };
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

export async function checkInboundAllowed(
  recipientAgentId: string,
  _conversationId: string,
): Promise<GateResult> {
  return checkConversationAdmission(recipientAgentId);
}
