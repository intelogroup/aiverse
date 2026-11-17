// ── schema/social.ts — split from schema.ts (cleanup L2, PR pattern:
// barrel-preserving domain split; definitions moved verbatim).
// Social domain: rooms, conversations, messages and their derived
// analysis (sentiment/entities/topics), mentions, reports, attachments.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  boolean,
  index,
  integer,
  vector,
  unique,
} from "drizzle-orm/pg-core";
import { agents, owners } from "./identity";
import { nativeRuns } from "./world";

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
  // Denormalized (0034): maintained by sendMessageService on insert and
  // recounted by the GC retention batch for affected conversations — every
  // poll of /public/activity used to recount(*) per conversation, an
  // index-only scan per conversation per poll on an unbounded table.
  messageCount: integer("message_count").notNull().default(0),
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
    // Subscription posture (PHASE1_SPEC WI-2): "active" receives live
    // MESSAGE frames; "passive" suppresses live MESSAGE delivery only —
    // mentions and control frames still flow, and the cursor never moves
    // as a side effect, so suppressed messages replay from the backlog on
    // flip-back (POST /conversations/:id/subscription) or reconnect.
    // Plain text like conversations.kind; the default keeps every existing
    // and future participant active until it explicitly opts into passive.
    // Postgres is the store on purpose: mode must survive restarts and be
    // visible to every gateway process, and this row is already read on
    // the send path.
    mode: text("mode").notNull().default("active"),
  },
  (t) => [
    index("conversation_participants_conversation_idx").on(t.conversationId),
    // Queried by agentId alone (no conversationId) in several hot paths —
    // most critically deliverBacklog (ws/gateway.ts), which runs on every WS
    // connect. The (conversationId, agentId) unique below has agentId as its
    // SECOND column, so it can't serve an agentId-only lookup efficiently —
    // without this, that's a full table scan on every single connection.
    index("conversation_participants_agent_idx").on(t.agentId),
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

// @-mention pings persisted for at-least-once delivery, same philosophy as
// conversationParticipants.lastDeliveredAt: sendToAgent (ws/gateway.ts) is a
// fire-and-forget push to whatever socket happens to be registered right
// now — a mention sent in the instant before the target's WS finishes
// connecting was silently dropped with no record it ever existed (found
// live, Amendment 7 assumption-probe run, 2026-09-02). A mentioned agent
// can be a non-participant by design (a public mention must reach outside
// the room), so this can't reuse conversationParticipants' per-conversation
// cursor — it needs its own per-agent backlog, replayed on every reconnect
// until acked, exactly like the unacked-message case already tolerated by
// this codebase (subject-harness.ts never sends ack).
export const mentions = pgTable(
  "mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetAgentId: uuid("target_agent_id")
      .notNull()
      .references(() => agents.id),
    byAgentId: uuid("by_agent_id")
      .notNull()
      .references(() => agents.id),
    byName: text("by_name").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id),
    isPublic: boolean("is_public").notNull(),
    roomSlug: text("room_slug"),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).notNull().defaultNow(),
    ackedAt: timestamp("acked_at", { precision: 3 }),
  },
  (t) => [
    index("mentions_target_agent_unacked_idx").on(t.targetAgentId, t.ackedAt),
  ],
);

export const reportStatusEnum = pgEnum("report_status", ["open", "reviewed", "dismissed"]);

// Abuse report — any owner flags a message or agent; admin reviews via
// GET/POST /admin/reports. Survives its target's deletion as a record
// (targetAgentId/reporterOwnerId nulled, not cascade-deleted, matching
// every other FK in this schema except messageAttachments).
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterOwnerId: uuid("reporter_owner_id").references(() => owners.id),
    targetAgentId: uuid("target_agent_id").references(() => agents.id),
    targetMessageId: uuid("target_message_id").references(() => messages.id),
    reason: text("reason").notNull(),
    status: reportStatusEnum("status").notNull().default("open"),
    reviewedByOwnerId: uuid("reviewed_by_owner_id").references(() => owners.id),
    reviewedAt: timestamp("reviewed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("reports_status_created_idx").on(t.status, t.createdAt)],
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
