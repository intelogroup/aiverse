import { sql, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { conversations } from "@aiverse/shared/schema";
import { log } from "../util/log";

// Lifecycle GC — boring but important. Policies:
// - unclaimed: 48h after claim_code_expires_at (leaked test agents, never claimed)
// - a2a_tasks submitted stuck >7d → canceled (inbox ceiling is 100, but submitted pile grows forever)
// - a2a_tasks/messages/console_events/security_events >30-90d → delete (retention)
// This is the last "boring" problem before freeze — not a feature, just hygiene.

// Bounded DELETE batches (2026-09-07 hot-path audit): a single unbounded
// DELETE over a 90-day slice of a multi-million-row table is one giant
// transaction — WAL spike, long lock hold, bloat. DELETE-with-LIMIT via an
// id-CTE in batches, looping to exhaustion with a per-pass ceiling so one
// GC run never hogs the DB. table/age come from the fixed call sites in
// runGc, never user input — sql.raw is safe here by construction.
export async function batchedDelete(
  table: string,
  maxAge: string,
  batchSize = 5000,
  maxBatches = 20,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    // Delete first, recount SECOND and separately (0034): a data-modifying
    // CTE sharing one statement with a recount subquery reads the
    // pre-statement snapshot — the recount would re-include the very rows
    // the CTE just deleted (verified live in the gc test: count stayed one
    // batch behind). The separate UPDATE below sees post-delete truth.
    const rows = (await db.execute(
      sql.raw(
        `WITH del AS (DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE created_at < now() - interval '${maxAge}' LIMIT ${batchSize}) RETURNING ${table === "messages" ? "conversation_id" : "1"}) SELECT * FROM del`,
      ),
    )) as any[];
    const n = rows.length;
    total += n;
    if (table === "messages" && n > 0) {
      const ids = [...new Set(rows.map((r) => r.conversation_id))] as string[];
      // recount the denormalized conversations.message_count for every
      // conversation this batch touched — it would otherwise silently drift
      // from retention deletes (the read path trusts it, it must stay exact)
      await db
        .update(conversations)
        .set({
          messageCount: sql`(SELECT count(*) FROM messages m WHERE m.conversation_id = ${conversations.id})`,
        })
        .where(inArray(conversations.id, ids));
    }
    if (n < batchSize) break;
  }
  return total;
}

export async function runGc(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    // 1) unclaimed agents expired >48h — delete children first (no CASCADE in schema)
    const expiredAgents = await db.execute(sql`
      SELECT id FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours' LIMIT 1000
    `);
    // db.execute() returns the postgres-js RowList itself (it IS the rows) —
    // .rows does not exist on it. Using .rows threw on every GC pass and the
    // catch block silently skipped steps 2-6 (stuck-task cancel + retention
    // deletes) — the whole job was dead, not just this query.
    const ids = (expiredAgents as any[]).map((r: any) => r.id);
    if (ids.length) {
      // delete dependents, then agents
      await db.execute(sql`DELETE FROM agent_wallets WHERE agent_id IN (SELECT id FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours')`);
      await db.execute(sql`DELETE FROM agent_policy_scope WHERE agent_id IN (SELECT id FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours')`);
      await db.execute(sql`DELETE FROM console_events WHERE agent_id IN (SELECT id FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours')`);
      // security_events.agent_id is nullable, delete references
      await db.execute(sql`DELETE FROM security_events WHERE agent_id IN (SELECT id FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours')`);
      const del = await db.execute(sql`DELETE FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours'`);
      out.unclaimed_purged = (del as any).rowCount ?? ids.length;
    } else out.unclaimed_purged = 0;

    // 2) stuck submitted tasks >7d → canceled (prevents 145 pile from growing forever, same as inbox ceiling but for age)
    const stuck = await db.execute(sql`UPDATE a2a_tasks SET state='canceled', updated_at=now() WHERE state='submitted' AND created_at < now() - interval '7 days'`);
    out.tasks_stuck_canceled = (stuck as any).rowCount ?? 0;

    // 3) old tasks >30d → delete (any terminal state; keeps submitted working recent)
    // Ordering invariant: task_outcomes (the durable outcome ledger) is
    // materialized from these rows by the hourly reconcile job BEFORE this
    // delete runs (terminal transitions happen by 7d at the latest, leaving
    // ~23 days of runway). NEVER add a task_outcomes delete here — the ledger
    // outlives a2a_tasks by design.
    out.tasks_old_deleted = await batchedDelete("a2a_tasks", "30 days");

    // 4) old messages >90d
    out.messages_old_deleted = await batchedDelete("messages", "90 days");

    // 5) old console_events >90d
    out.console_old_deleted = await batchedDelete("console_events", "90 days");

    // 6) security_events >90d (immutable stream, but needs retention bound)
    out.security_old_deleted = await batchedDelete("security_events", "90 days");

    log("gc_run", out);
  } catch (e) {
    log("gc_error", { error: String(e) });
  }
  return out;
}

// Run once on boot + every 24h (Bun/Node setInterval survives as long as process does)
export function scheduleGc() {
  runGc();
  setInterval(runGc, 24 * 60 * 60 * 1000);
  // unref so it doesn't block shutdown in tests
  // @ts-ignore
  if (typeof Bun !== "undefined") return;
}
