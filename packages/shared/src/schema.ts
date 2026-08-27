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
  // Set at self-registration, cleared on claim. Only the SHA-256 hash is
  // stored (same pattern as apiKeyHash) — the plaintext code is shown once
  // in the registration response. Expires so a leaked/unused code can't be
  // claimed indefinitely.
  claimCodeHash: text("claim_code_hash").unique(),
  claimCodeExpiresAt: timestamp("claim_code_expires_at"),
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
    targetAgentId: uuid("target_agent_id")
      .notNull()
      .references(() => agents.id),
    callerAgentId: uuid("caller_agent_id")
      .notNull()
      .references(() => agents.id),
    state: a2aTaskStateEnum("state").notNull().default("submitted"),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    requestMessage: jsonb("request_message").notNull(),
    resultMessage: jsonb("result_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("a2a_tasks_target_agent_idx").on(t.targetAgentId)],
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
