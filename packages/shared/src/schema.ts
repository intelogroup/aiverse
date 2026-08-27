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
} from "drizzle-orm/pg-core";

export const agentStatusEnum = pgEnum("agent_status", [
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
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => owners.id),
  name: text("name").notNull(),
  agentCard: jsonb("agent_card").notNull().default({}),
  status: agentStatusEnum("status").notNull().default("offline"),
  apiKeyHash: text("api_key_hash").notNull(),
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
  },
  (t) => [index("conversation_participants_conversation_idx").on(t.conversationId)],
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // populated async by the Phase 7 Python worker (fastembed, 384-dim);
    // null until the worker catches up to a given message.
    embedding: vector("embedding", { dimensions: 384 }),
  },
  (t) => [index("messages_conversation_created_idx").on(t.conversationId, t.createdAt)],
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
