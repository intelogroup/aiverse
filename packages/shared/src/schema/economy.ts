// ── schema/economy.ts — split from schema.ts (cleanup L2, PR pattern:
// barrel-preserving domain split; definitions moved verbatim).
// Economy domain: wallets, policy scope, usage, mandates, A2A tasks,
// the outcome ledger, and goals.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  pgEnum,
  boolean,
  index,
  integer,
  date,
  unique,
} from "drizzle-orm/pg-core";
import { agents, owners } from "./identity";

export const autonomyModeEnum = pgEnum("autonomy_mode", [
  "observe",
  "assist",
  "autonomous",
]);

export const agentWallets = pgTable("agent_wallets", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id),
  dailyTokenBudget: integer("daily_token_budget").notNull().default(500_000),
  maxTokensPerConversation: integer("max_tokens_per_conversation").notNull().default(20_000),
  maxSimultaneousConversations: integer("max_simultaneous_conversations").notNull().default(20),
  maxAgentCallsPerDay: integer("max_agent_calls_per_day").notNull().default(100),
  spendingAuthorityCents: integer("spending_authority_cents").notNull().default(0),
  // Default is autonomous, not observe: verse-ecology testing (2026-08/09)
  // showed agents left on "observe" (the old default) never send at all —
  // the eager-contrast cohort (autonomous + a reply-aware mandate) is what
  // actually thrives. spendingAuthorityCents still defaults to 0 below, so
  // this alone grants send/reply/join, not spend — an owner must separately
  // raise the cents cap for economic authority.
  autonomyMode: autonomyModeEnum("autonomy_mode").notNull().default("autonomous"),
});

export const agentPolicyScope = pgTable("agent_policy_scope", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id),
  allowedTopics: text("allowed_topics").array().notNull().default([]),
  allowedTools: text("allowed_tools").array().notNull().default([]),
  trustedAgentIds: uuid("trusted_agent_ids").array().notNull().default([]),
  blockedAgentIds: uuid("blocked_agent_ids").array().notNull().default([]),
  // Admission/execution policy, not spend — deliberately not on agentWallets.
  // Caps concurrent outstanding A2A tasks this agent may have active under a
  // single (goal) contextId at once. See a2aTasks.delegationLeaseExpiresAt.
  maxParallelDelegations: integer("max_parallel_delegations").notNull().default(3),
});

export const walletUsageDaily = pgTable(
  "wallet_usage_daily",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    date: date("date").notNull(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    agentCallsMade: integer("agent_calls_made").notNull().default(0),
    spendCents: integer("spend_cents").notNull().default(0),
  },
  (t) => [index("wallet_usage_daily_agent_date_idx").on(t.agentId, t.date)],
);

// Human mandate — what turns a registered agent into a personal agent. The
// owner authors it; the agent carries it. Standing objectives, behavior
// preferences, and work-initiation permissions live here so an agent entering
// AIVerse already knows what its human wants and what work it may start
// unprompted. Deliberate non-duplicates: spend ceilings stay on agentWallets,
// trust/block on agentPolicyScope — the mandate references posture, it never
// copies a gate. Owner-only write path (an agent can never self-authorize a
// bigger mandate, same hard invariant as wallets).
export const agentMandates = pgTable("agent_mandates", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => owners.id),
  // Standing objectives the human wants pursued over time — array of strings.
  // These are NOT goals: the agent derives goals from them as it acts.
  // A goal is one task-shaped instance; an objective is the standing want.
  objectives: jsonb("objectives").notNull().default([]),
  // Style/behavior preferences (verbosity, risk posture, tone, ...). Freeform
  // jsonb object — v1 deliberately avoids a schema agents must adopt.
  preferences: jsonb("preferences").notNull().default({}),
  // What work the agent may initiate unprompted, e.g.
  // { initiateGoals: true, unsolicitedMessages: false, delegateToUntrusted: false }.
  // v1 is DECLARATIVE (the agent reads and honors it; gates don't enforce it
  // yet) — enforcement wiring waits for evidence it's needed.
  permissions: jsonb("permissions").notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Phase 8 (A2A 0.3.0, pinned — see plan). Mirrors A2A's TaskState enum plus
// AIVerse's own target-side authorization primitive (requiresApproval).
export const a2aTaskStateEnum = pgEnum("a2a_task_state", [
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
  "auth-required",
]);

export const a2aTasks = pgTable(
  "a2a_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // A2A Task.contextId — groups related tasks/interactions. AIVerse has no
    // multi-task-per-conversation concept yet, so one task = one context;
    // defaults on insert so existing callers don't need to pass it.
    contextId: uuid("context_id").notNull().defaultRandom(),
    targetAgentId: uuid("target_agent_id")
      .notNull()
      .references(() => agents.id),
    callerAgentId: uuid("caller_agent_id")
      .notNull()
      .references(() => agents.id),
    // Idempotency key for message/send retries — caller-supplied messageId.
    // Nullable so old rows / callers without a messageId still work; unique
    // per (caller, messageId) so a retry returns the same task, no double
    // spend (mirrors messages.client_message_id pattern).
    callerMessageId: text("caller_message_id"),
    state: a2aTaskStateEnum("state").notNull().default("submitted"),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    requestMessage: jsonb("request_message").notNull(),
    resultMessage: jsonb("result_message"),
    // Governs only whether this task still occupies one of the caller's
    // parallel-delegation slots (see policy/gate.ts admitAndCreateTask) —
    // independent of task lifecycle/delivery. A task whose lease has expired
    // is still fully valid, deliverable, and pollable; nothing auto-cancels
    // it. Null for tasks created outside a goal-scoped (contextId) fan-out —
    // those were never subject to the cap and have nothing to expire.
    delegationLeaseExpiresAt: timestamp("delegation_lease_expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("a2a_tasks_target_agent_idx").on(t.targetAgentId),
    index("a2a_tasks_caller_message_idx").on(t.callerAgentId, t.callerMessageId),
    unique("a2a_tasks_caller_message_unique").on(t.callerAgentId, t.callerMessageId),
    index("a2a_tasks_caller_context_state_idx").on(t.callerAgentId, t.contextId, t.state),
  ],
);

// Outcome ledger — THE product primitive underneath reputation, the native
// traffic curve, and the human-accepted-work north star. Materialized from
// terminal a2a_tasks by the hourly reconcile job (jobs/outcomeLedger.ts),
// NOT by transition hooks: tasks reach terminal states via both A2A routes
// and gc.ts bulk-cancel, and a2a_tasks rows are DELETED after 30 days — this
// ledger must outlive them, so it holds denormalized copies and plain uuid
// references (no FKs). Append-only except goalAccepted backfill. gc.ts must
// NEVER delete from this table.
export const taskOutcomes = pgTable(
  "task_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // a2a_tasks.id — unique + ON CONFLICT DO NOTHING keeps reconcile idempotent.
    // Plain uuid: the task row is deleted after 30 days.
    taskId: uuid("task_id").notNull().unique(),
    // goals.contextId — durable goal↔task lineage (the goals row is never GC'd).
    contextId: uuid("context_id").notNull(),
    targetAgentId: uuid("target_agent_id").notNull(), // plain uuid, agents can be purged
    callerAgentId: uuid("caller_agent_id").notNull(),
    // Quarantine ("natives calibrate, never rank") and the native-traffic
    // share curve fall out of these two flags. Denormalized at reconcile time
    // because the referenced agents row may be purged later.
    targetIsNative: boolean("target_is_native").notNull(),
    callerIsNative: boolean("caller_is_native").notNull(),
    // Terminal state only (completed | failed | canceled | rejected).
    state: a2aTaskStateEnum("state").notNull(),
    // updated_at - created_at at the moment of terminal transition.
    latencyMs: integer("latency_ms"),
    // null = no owner verdict yet; true = parent goal accepted; false = rejected.
    // Backfilled by the accept/reject endpoints plus the reconcile sweep (which
    // catches verdicts that arrived before this row was materialized).
    goalAccepted: boolean("goal_accepted"),
    // Nullable native-experiment provenance — set when the source a2a_task's
    // request_message carries a runId (native:runId:seq) AND that id exists
    // in native_runs (the reconcile job verifies before storing; the raw
    // caller string never lands here). DELIBERATELY a plain uuid with NO FK:
    // the raw value is caller-supplied, and a hard FK would let any agent
    // poison the whole materialization batch with one fake uuid (FK violation
    // kills the INSERT, the job's try/catch swallows it, and the ledger
    // silently halts). Stored value is therefore GUARANTEED by the job to be
    // a verified native_runs.id, or NULL (malformed / nonexistent / ordinary
    // non-experiment task).
    sourceRunId: uuid("source_run_id"),
    // When the TASK happened (copied from a2a_tasks.created_at), not when this
    // row was materialized (at most an hour later).
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("task_outcomes_target_state_idx").on(t.targetAgentId, t.state),
    index("task_outcomes_caller_state_idx").on(t.callerAgentId, t.state),
    index("task_outcomes_context_idx").on(t.contextId),
    index("task_outcomes_source_run_idx").on(t.sourceRunId),
  ],
);

export const goalStatusEnum = pgEnum("goal_status", [
  "open",
  "researching",
  "synthesized",
  "closed",
  // Verdict states — owner-only transitions (ownerGoalsRoute accept/reject).
  // The agent PROPOSES synthesized; only the human owner can transition to
  // accepted/rejected. Self-graded goals must never feed the outcome ledger.
  "accepted",
  "rejected",
]);

// Human goal — durable correlation boundary for useful work.
// Agent creates/updates, console watches. contextId is reused as a2aTasks.contextId
// so one goal → many A2A tasks share same context.
export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contextId: uuid("context_id").notNull().defaultRandom().unique(),
    ownerId: uuid("owner_id").notNull().references(() => owners.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    objective: text("objective").notNull(),
    status: goalStatusEnum("status").notNull().default("open"),
    result: jsonb("result"),
    // Set only by the owner-only accept transition (ownerGoalsRoute
    // /goals/:id/accept). Null for rejected goals and anything pre-verdict.
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("goals_owner_idx").on(t.ownerId), index("goals_agent_idx").on(t.agentId), index("goals_context_idx").on(t.contextId)],
);
