// ── schema/world.ts — split from schema.ts (cleanup L2, PR pattern:
// barrel-preserving domain split; definitions moved verbatim).
// World domain: native experiment runs, visits, agent memory,
// egg claims, and the public agent event log.
import {
  pgTable,
  primaryKey,

  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  integer,
  unique,
  boolean,
  vector,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { goals } from "./economy";
import { agents, owners } from "./identity";

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

// A time-and-action-boxed autonomous session: "send my agent into the Verse
// for 2 hours, at most 200 actions." The owner-only surface for starting one
// is deliberately narrow (POST .../visits, POST .../visits/:id/stop) — an
// agent cannot extend, raise the cap on, or end its own visit; the same
// "owner sets the envelope, agent acts inside it" split as the wallet.
// Enforcement lives in middleware/agentAuth.ts (every authed call checks the
// active visit, a non-GET call counts against it) plus jobs/visits.ts (a
// leader-only sweep that ends a visit whose deadline or action cap passed
// even if the agent never calls in again). Presence NEVER ends a visit: the
// sweep only keeps the offlineSince quiet-marker current, and even that
// judgment is corroborated against agents.lastSeenAt — an earlier design
// ended visits after a presence grace, which became the 2026-11-12
// presence wall when a stale leader build on a separate Redis store read
// every sibling-served agent as offline and ended their visits at
// claim + ~10.5 min.
export const agentVisits = pgTable(
  "agent_visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    // Nullable since owner account deletion (Phase 5): the visit history
    // belongs to the agent's record, so deleting the owner ends any active
    // visit and nulls this column on the history rows instead of deleting
    // them. An ACTIVE visit always has a non-null owner — deletion ends
    // visits before it nulls anything.
    ownerId: uuid("owner_id").references(() => owners.id),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    endsAt: timestamp("ends_at").notNull(),
    maxActions: integer("max_actions").notNull(),
    actionsUsed: integer("actions_used").notNull().default(0),
    // Set by the sweep the first tick it finds the agent with no live
    // presence key, cleared the first tick it finds one again — the sweep's
    // own record of "since when has this agent been unreachable", not
    // updated on the request path.
    offlineSince: timestamp("offline_since"),
    endedAt: timestamp("ended_at"),
    endedReason: text("ended_reason"),
  },
  (t) => [
    // The "does this agent have an active visit" check (agentAuth, every
    // authed request) and "one active visit per agent" check (starting a
    // new one) are both WHERE agent_id = ? AND ended_at IS NULL.
    index("agent_visits_agent_active_idx").on(t.agentId, t.endedAt),
    // "One active visit per agent" as a database invariant, not just a
    // route-level check: the start route's findFirst-then-insert raced
    // under concurrency (a 12-way burst of starts left 9–10 active
    // visits). Partial — ended visits don't participate, so visit
    // history stays unconstrained. The start route and the claim-time
    // auto-start map the 23505 from this index to their 409 /
    // already-active outcomes.
    uniqueIndex("agent_visits_one_active_per_agent_idx")
      .on(t.agentId)
      .where(sql`${t.endedAt} is null`),
  ],
);

// Native-agent memory v1 — deliberately flat, no embeddings/RAG. Whether
// persistent recall changes behavior is the thing being tested; a richer
// store is only worth building once that's confirmed.
//
// v2 (2026-11-22, visit-end distillation): three nullable additions, all
// set only for rows the distillation job writes when a visit ends —
// sourceVisitId (provenance: which visit produced this entry), entryHash
// (sha-256 of the normalized content; with agentId+sourceVisitId it forms
// the idempotency key that makes re-processing a visit a no-op), and
// embedding (384-dim, same pgvector convention as messages.embedding;
// populated through the gateway's embedder interface, null when no
// embedding provider is configured). Agent-written rows (POST /memory)
// leave all three null, and Postgres treats NULLs as distinct in the
// unique index, so the v1 write path is unconstrained by it.
export const agentMemory = pgTable(
  "agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    type: text("type").notNull(), // interaction | encountered_agent | conclusion | goal_note
    content: text("content").notNull(),
    sourceMessageId: uuid("source_message_id"),
    // Which visit's end-of-visit distillation produced this entry, if any.
    sourceVisitId: uuid("source_visit_id").references(() => agentVisits.id),
    // sha-256 of the distilled entry's normalized text (distilled rows only).
    entryHash: text("entry_hash"),
    // 384-dim pgvector, same convention as messages.embedding; null until
    // an embedder is configured and the row is processed.
    embedding: vector("embedding", { dimensions: 384 }),
    // Which experiment run produced this memory row, if any. Authoritative for
    // experiment attribution; cross-checked in tests against
    // sourceMessageId → messages.runId (must agree) but NOT mandatory here,
    // because some legitimate memories are not message-derived.
    runId: uuid("run_id").references(() => nativeRuns.id),
    // Which goal (if any) this row belongs to — nullable, since a mandate-only
    // run that never calls create_goal still needs to write memory, just
    // untagged. Lets an owner ask "what did you learn" scoped to one goal
    // instead of an agent's whole lifetime.
    goalId: uuid("goal_id").references(() => goals.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("agent_memory_agent_idx").on(t.agentId, t.createdAt),
    index("agent_memory_goal_idx").on(t.goalId),
    // Distillation idempotency: one row per (agent, visit, entry). Only
    // distilled rows carry all three values, so only they participate.
    uniqueIndex("agent_memory_distilled_unique").on(t.agentId, t.sourceVisitId, t.entryHash),
  ],
);

// Visit-end memory distillation queue. endVisitRecord (policy/visits.ts)
// inserts one row per visit in the same breath as the guarded end UPDATE
// lands — only the caller whose UPDATE won the race gets a row back from
// its insert attempt, so exactly one row ever exists per visit
// (visit_id UNIQUE is the backstop). The leader-only job
// (jobs/memoryDistillation.ts) claims pending rows, distills the visit's
// record into agent_memory entries, and settles the row done/failed;
// a failure here never touches the visit itself.
export const visitDistillations = pgTable(
  "visit_distillations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    visitId: uuid("visit_id").notNull().unique().references(() => agentVisits.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    status: text("status").notNull().default("pending"), // pending | processing | done | failed
    attempts: integer("attempts").notNull().default(0),
    entriesWritten: integer("entries_written").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("visit_distillations_status_idx").on(t.status, t.createdAt)],
);

// What an agent carries back from the Verse to its owner. Two tiers: `ledger` rows are written by the server from things it saw (a visit,
// a hunt win) and can be trusted; `note` rows are the agent's own words (world_remember) and are shown as claims. Flat rows, no
// embeddings: recall is by place, kind and recency. Separate from agent_memory, which belongs to native agents and goals.
export const verseMemory = pgTable(
  "verse_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    // Copied from the agent at write time so the owner read is one indexed query. Not a FK: the agent's cascade removes the rows.
    ownerId: uuid("owner_id").notNull(),
    visitId: uuid("visit_id"),
    tier: text("tier").notNull(), // ledger | note
    kind: text("kind").notNull(), // visit | find | place | person | lesson | note
    text: text("text").notNull(),
    placeId: text("place_id"),
    pointX: doublePrecision("point_x"),
    pointZ: doublePrecision("point_z"),
    subject: text("subject"), // a body handle or prop id the row is about
    pinned: boolean("pinned").notNull().default(false),
    seenByOwnerAt: timestamp("seen_by_owner_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("verse_memory_agent_idx").on(t.agentId, t.createdAt),
    index("verse_memory_owner_idx").on(t.ownerId, t.createdAt),
    index("verse_memory_place_idx").on(t.agentId, t.placeId),
  ],
);

// Egg claims: one payload per agent per egg, ever. The unique pair is the claim lock (see routes/eggs.ts).
export const eggClaims = pgTable(
  "egg_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    eggId: text("egg_id").notNull(),
    claimedAt: timestamp("claimed_at").notNull().defaultNow(),
  },
  (t) => [unique("egg_claims_agent_egg_unique").on(t.agentId, t.eggId)],
);

export const eggHuntWins = pgTable("egg_hunt_wins", {
  contestId: text("contest_id").primaryKey(),
  // Preserve the win if the agent is deleted. A deleted winner never reopens the contest.
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  ownerId: uuid("owner_id").references(() => owners.id, { onDelete: "set null" }),
  payload: text("payload").notNull(),
  credits: integer("credits").notNull(),
  wonAt: timestamp("won_at").notNull().defaultNow(),
});

export const eggCashBounties = pgTable("egg_cash_bounties", {
  id: text("id").primaryKey(),
  clue: text("clue").notNull(),
  eggId: text("egg_id").notNull(),
  payload: text("payload").notNull(),
  amountCents: integer("amount_cents").notNull(),
  mode: text("mode").$type<"sandbox" | "live">().notNull(),
  current: boolean("current").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => [uniqueIndex("egg_cash_bounties_one_current").on(t.current).where(sql`${t.current}`)]);

// Public log of what an agent visibly did. Actions only (see shared/events.ts); never goals or reasoning.
export const agentEvents = pgTable(
  "agent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    type: text("type").notNull(),
    detail: text("detail").notNull().default(""),
    visibility: text("visibility").notNull().default("public"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("agent_events_agent_created_idx").on(t.agentId, t.createdAt)],
);

export const verseInventory = pgTable("verse_inventory", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  revision: integer("revision").notNull().default(0),
}, (t) => [index("verse_inventory_agent_idx").on(t.agentId, t.id)]);

export const verseSaleOffers = pgTable("verse_sale_offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").references(() => verseInventory.id, { onDelete: "set null" }),
  itemName: text("item_name").notNull(),
  itemRevision: integer("item_revision").notNull(),
  sellerId: uuid("seller_id").references(() => agents.id, { onDelete: "set null" }),
  buyerId: uuid("buyer_id").references(() => agents.id, { onDelete: "set null" }),
  price: integer("price").notNull(),
  purchasedAt: timestamp("purchased_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("verse_sale_offers_open_item_idx").on(t.itemId, t.itemRevision).where(sql`${t.purchasedAt} is null`),
  index("verse_sale_offers_seller_receipts_idx").on(t.sellerId, t.purchasedAt),
  index("verse_sale_offers_buyer_receipts_idx").on(t.buyerId, t.purchasedAt),
]);

export const verseBounties = pgTable("verse_bounties", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  rewardName: text("reward_name").notNull(),
  closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  winnerAgentId: uuid("winner_agent_id").references(() => agents.id, { onDelete: "set null" }),
  rewardItemId: uuid("reward_item_id").references(() => verseInventory.id, { onDelete: "set null" }),
});

export const verseBountyClaims = pgTable("verse_bounty_claims", {
  bountyId: uuid("bounty_id").notNull().references(() => verseBounties.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.bountyId, t.agentId] })]);

export const verseProgressEvents = pgTable("verse_progress_events", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  source: text("source").notNull(),
  credits: integer("credits").notNull().default(0),
  xp: integer("xp").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.agentId, t.kind, t.source] })]);

export const versePickupClaims = pgTable("verse_pickup_claims", {
  pickupId: text("pickup_id").primaryKey(),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  itemId: uuid("item_id").references(() => verseInventory.id, { onDelete: "set null" }),
});
