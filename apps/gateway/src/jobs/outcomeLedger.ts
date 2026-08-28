import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { log } from "../util/log";

// Outcome-ledger reconciliation — materializes terminal a2a_tasks into
// task_outcomes (see packages/shared/src/schema.ts for why it's a reconcile
// job, not transition hooks). Idempotent: unique(task_id) + ON CONFLICT DO
// NOTHING means re-runs, crashes and races can't duplicate rows. Never throws
// into the caller (gc.ts style) — a broken ledger must not take the gateway
// down, and the next hourly pass self-heals whatever it missed.
export async function reconcileTaskOutcomes(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    // 1) Terminal tasks not yet materialized. LEFT JOIN agents: the referenced
    // agent row may already be purged (unclaimed GC) — is_native denormalizes
    // to false in that case. created_at copies the TASK's creation time (when
    // the work happened), not the materialization time (at most an hour later).
    const ins = await db.execute(sql`
      INSERT INTO task_outcomes
        (task_id, context_id, target_agent_id, caller_agent_id,
         target_is_native, caller_is_native, state, latency_ms, source_run_id, created_at)
      SELECT t.id, t.context_id, t.target_agent_id, t.caller_agent_id,
             COALESCE(ta.is_native, false),
             COALESCE(ca.is_native, false),
             t.state,
             GREATEST(0, (EXTRACT(EPOCH FROM (t.updated_at - t.created_at)) * 1000)::int),
             -- run attribution: request_message.runId when the caller stamped one.
             -- CASE guard, not a bare cast: ONE malformed string would fail the whole
             -- INSERT batch and silently halt every future materialization (the
             -- try/catch would swallow it). Also verifies the referenced row
             -- actually exists in native_runs, so the FK can never be violated.
             CASE WHEN t.request_message->>'runId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  AND EXISTS (SELECT 1 FROM native_runs nr WHERE nr.id = (t.request_message->>'runId')::uuid)
                  THEN (t.request_message->>'runId')::uuid
             END,
             t.created_at
      FROM a2a_tasks t
      LEFT JOIN agents ta ON ta.id = t.target_agent_id
      LEFT JOIN agents ca ON ca.id = t.caller_agent_id
      WHERE t.state IN ('completed', 'failed', 'canceled', 'rejected')
      ON CONFLICT (task_id) DO NOTHING
      RETURNING 1
    `);
    out.materialized = (ins as any).rowCount ?? 0;

    // 2) Verdict sweep — owner verdicts that arrived BEFORE the ledger row was
    // materialized (the accept/reject endpoints only backfill rows that exist
    // at verdict time). Stamps every task in a verdicted goal's context.
    const upd = await db.execute(sql`
      UPDATE task_outcomes o
      SET goal_accepted = (g.status = 'accepted')
      FROM goals g
      WHERE g.context_id = o.context_id
        AND g.status IN ('accepted', 'rejected')
        AND o.goal_accepted IS DISTINCT FROM (g.status = 'accepted')
    `);
    out.verdict_backfilled = (upd as any).rowCount ?? 0;

    if (out.materialized || out.verdict_backfilled) log("outcome_ledger_reconcile", out);
  } catch (e) {
    log("outcome_ledger_error", { error: String(e) });
  }
  return out;
}

// Run once on boot + hourly. Ordering invariant vs gc.ts: a2a_tasks rows are
// deleted 30 days after creation, and stuck submitted tasks are bulk-canceled
// at 7 days — an hourly sweep materializes every terminal task with ~23 days
// of runway before its source row disappears. Never GC task_outcomes itself.
export function scheduleOutcomeLedger() {
  reconcileTaskOutcomes();
  setInterval(reconcileTaskOutcomes, 60 * 60 * 1000);
  // @ts-ignore
  if (typeof Bun !== "undefined") return;
}