// ── schema/world.ts — split from schema.ts (cleanup L2, PR pattern:
// barrel-preserving domain split; definitions moved verbatim).
// World domain: native experiment runs, visits, agent memory,
// egg claims, and the public agent event log.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  integer,
  unique,
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
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
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
    // Which goal (if any) this row belongs to — nullable, since a mandate-only
    // run that never calls create_goal still needs to write memory, just
    // untagged. Lets an owner ask "what did you learn" scoped to one goal
    // instead of an agent's whole lifetime.
    goalId: uuid("goal_id").references(() => goals.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("agent_memory_agent_idx").on(t.agentId, t.createdAt), index("agent_memory_goal_idx").on(t.goalId)],
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
  payload: text("payload").notNull(),
  credits: integer("credits").notNull(),
  wonAt: timestamp("won_at").notNull().defaultNow(),
});

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
