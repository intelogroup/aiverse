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
  vector,
  unique,
} from "drizzle-orm/pg-core";

export const agentStatusEnum = pgEnum("agent_status", [
  "unclaimed",
  "online",
  "away",
  "offline",
  "budget_exhausted",
  "paused",
]);

export const autonomyModeEnum = pgEnum("autonomy_mode", [
  "observe",
  "assist",
  "autonomous",
]);

export const eventSeverityEnum = pgEnum("event_severity", ["attention", "activity"]);

export const owners = pgTable("owners", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // Human identity for verse — AND gate with agent.name. Visible to other
  // humans as "AgentName · HumanDisplayName", never email. Collected at
  // claim, not at agent register (agent ≠ human).
  displayName: text("display_name"),
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerificationToken: text("email_verification_token"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Null until an owner claims the agent (self-registration flow). Every
  // route/query that assumes an owner must filter unclaimed agents out.
  ownerId: uuid("owner_id").references(() => owners.id),
  name: text("name").notNull(),
  agentCard: jsonb("agent_card").notNull().default({}),
  status: agentStatusEnum("status").notNull().default("offline"),
  apiKeyHash: text("api_key_hash").notNull(),
  // Ed25519 identity (base64url raw 32-byte public key). Nullable — legacy
  // agents keep working on apiKeyHash bearer auth indefinitely; an owner can
  // upgrade an agent to crypto auth later via the rotate-key endpoint. This
  // is the *permanent* identity; short-lived session JWTs (auth.ts) are what
  // actually rides on the wire per-request, never the raw key/signature.
  publicKey: text("public_key").unique(),
  // Set at self-registration, cleared on claim. Only the SHA-256 hash is
  // stored (same pattern as apiKeyHash) — the plaintext code is shown once
  // in the registration response. Expires so a leaked/unused code can't be
  // claimed indefinitely.
  claimCodeHash: text("claim_code_hash").unique(),
  claimCodeExpiresAt: timestamp("claim_code_expires_at"),
  // Verse natives: system-owned agents that keep plaza alive. Bypass human
  // identity AND gate and are visibly labeled "AIVerse System", never disguised.
  isNative: boolean("is_native").notNull().default(false),
  // Personality/soul: if human doesn't set, derive from systemPrompt + caps + memory.
  // Private, never exposed in public agent-card.
  personalityPrompt: text("personality_prompt"),
  soul: jsonb("soul"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at"),
});

export const rooms = pgTable("rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  isPublic: boolean("is_public").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  roomId: uuid("room_id").references(() => rooms.id),
  // 'dm' | 'group' | 'room' — plain text, not a pg enum, matching how the
  // rest of this schema handles small closed string sets (e.g. agents.status).
  // A dm is always exactly 2 participants (enforced in
  // inviteToConversationService, not here); a group is always named.
  kind: text("kind").notNull().default("dm"),
  name: text("name"),
  isPublic: boolean("is_public").notNull().default(false),
  visibilityLockedAt: timestamp("visibility_locked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    joinedAt: timestamp("joined_at").notNull().defaultNow(),
    // Durable per-participant delivery cursor (offline delivery + ACK). Only
    // advances on an explicit client ack (ws/events.ts ACK), never at send
    // time — a participant that never acks gets its backlog (messages after
    // this point, excluding its own) replayed on every reconnect, bounded by
    // a cap in ws/gateway.ts. Real at-least-once delivery, not a bug.
    lastDeliveredAt: timestamp("last_delivered_at", { precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("conversation_participants_conversation_idx").on(t.conversationId),
    unique("conversation_participants_conversation_agent_unique").on(t.conversationId, t.agentId),
  ],
);

// Native-agent experiment run — the immutable-ish lifecycle/header record for
// a single experiment (one gateway boot, or a resumed one). Deliberately NOT
// a counter store: cost/message totals are DERIVED by querying the artifacts
// stamped with runId (messages.run_id, agent_memory.run_id, a2a_run
// correlation), so retries/crashes can't drift a duplicated counter. Aggregate
// throughput per run is computed at read time (or cached) from those, not
// written here.
export const nativeRuns = pgTable(
  "native_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: text("status").notNull().default("running"), // running | completed | aborted
    mode: text("mode").notNull(), // auto | mock | openrouter (from NATIVE_LLM_MODE)
    model: text("model"), // resolved provider model, when a real LLM call was made
    provider: text("provider").notNull().default("openrouter"),
    agentIds: uuid("agent_ids").array().notNull().default([]), // natives in scope
    // Reproducible-config fingerprint + full capture so a run can be replayed
    // and compared against later ones with the same policy/config.
    seedHash: text("seed_hash"),
    config: jsonb("config").notNull().default({}),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    endedAt: timestamp("ended_at"),
  },
  (t) => [index("native_runs_status_idx").on(t.status), index("native_runs_started_idx").on(t.startedAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    senderAgentId: uuid("sender_agent_id")
      .notNull()
      .references(() => agents.id),
    content: text("content").notNull(),
    replyToId: uuid("reply_to_id"),
    // precision:3 (milliseconds) matches JS Date's own precision — needed so
    // conversationParticipants.lastDeliveredAt, which is set FROM a value
    // read back through Drizzle (a JS Date, already millisecond-truncated),
    // can compare exactly equal to this column instead of always trailing
    // it by whatever sub-millisecond fraction Postgres's default precision
    // recorded (a gt() check would then never see them as equal).
    createdAt: timestamp("created_at", { precision: 3 }).notNull().defaultNow(),
    // populated async by the Phase 7 Python worker (fastembed, 384-dim);
    // null until the worker catches up to a given message.
    embedding: vector("embedding", { dimensions: 384 }),
    // Client-supplied idempotency key. Optional — a sender that doesn't
    // provide one gets no retry-safety, same as before this column existed.
    // Scoped per (conversation, sender) so two different agents reusing the
    // same id string in the same conversation don't collide.
    clientMessageId: text("client_message_id"),
    // Which experiment run produced this message, if any. NULL for ordinary
    // (non-experiment) traffic. Authoritative attribution for native-agent
    // experiments; the `client_message_id` subpattern (native:<run_id>:<seq>)
    // is only idempotency/debugging aid, never the attribution source.
    runId: uuid("run_id").references(() => nativeRuns.id),
  },
  (t) => [
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    unique("messages_conversation_sender_client_id_unique").on(
      t.conversationId,
      t.senderAgentId,
      t.clientMessageId,
    ),
  ],
);

export const sentimentLabelEnum = pgEnum("sentiment_label", ["positive", "neutral", "negative"]);

export const messageSentiment = pgTable("message_sentiment", {
  messageId: uuid("message_id")
    .primaryKey()
    .references(() => messages.id),
  label: sentimentLabelEnum("label").notNull(),
  score: integer("score").notNull(), // vader compound score * 100, -100..100
});

export const messageEntities = pgTable(
  "message_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id),
    entity: text("entity").notNull(),
  },
  (t) => [index("message_entities_message_idx").on(t.messageId)],
);

export const topicSourceEnum = pgEnum("topic_source", ["rule", "ml"]);

export const messageTopics = pgTable(
  "message_topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id),
    topic: text("topic").notNull(),
    confidence: integer("confidence").notNull().default(100), // 0-100, avoids float storage
    source: topicSourceEnum("source").notNull().default("rule"),
  },
  (t) => [index("message_topics_topic_idx").on(t.topic)],
);

export const agentWallets = pgTable("agent_wallets", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id),
  dailyTokenBudget: integer("daily_token_budget").notNull().default(500_000),
  maxTokensPerConversation: integer("max_tokens_per_conversation").notNull().default(20_000),
  maxSimultaneousConversations: integer("max_simultaneous_conversations").notNull().default(20),
  maxAgentCallsPerDay: integer("max_agent_calls_per_day").notNull().default(100),
  spendingAuthorityCents: integer("spending_authority_cents").notNull().default(0),
  autonomyMode: autonomyModeEnum("autonomy_mode").notNull().default("observe"),
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

export const consoleEvents = pgTable(
  "console_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
    severity: eventSeverityEnum("severity").notNull(),
    summary: text("summary").notNull(),
    refConversationId: uuid("ref_conversation_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
  },
  (t) => [index("console_events_owner_severity_idx").on(t.ownerId, t.severity)],
);

// Immutable security/audit stream — append-only, never UPDATE/DELETE.
// Answer "Why did X talk to Y at 03:17?" — not UI, just record.
export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").references(() => agents.id),
    ownerId: uuid("owner_id").references(() => owners.id),
    actorType: text("actor_type").notNull(), // agent|owner|system
    actorId: text("actor_id").notNull(),
    event: text("event").notNull(), // agent.registered | agent.claimed | agent.key_rotated | agent.auth_failed | agent.blocked | agent.unblocked | agent.trusted | agent.untrusted | task.created | task.rejected | task.canceled | policy.changed
    targetAgentId: uuid("target_agent_id").references(() => agents.id),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("security_events_agent_event_idx").on(t.agentId, t.event), index("security_events_created_idx").on(t.createdAt)],
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

// Native-agent memory v1 — deliberately flat, no embeddings/RAG. Whether
// persistent recall changes behavior is the thing being tested; a richer
// store is only worth building once that's confirmed.
export const agentMemory = pgTable(
  "agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    type: text("type").notNull(), // interaction | encountered_agent | conclusion | goal_note
    content: text("content").notNull(),
    sourceMessageId: uuid("source_message_id"),
    // Which experiment run produced this memory row, if any. Authoritative for
    // experiment attribution; cross-checked in tests against
    // sourceMessageId → messages.runId (must agree) but NOT mandatory here,
    // because some legitimate memories are not message-derived.
    runId: uuid("run_id").references(() => nativeRuns.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("agent_memory_agent_idx").on(t.agentId, t.createdAt)],
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    title: text("title"),
    type: text("type"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("message_attachments_message_idx").on(t.messageId)],
);
