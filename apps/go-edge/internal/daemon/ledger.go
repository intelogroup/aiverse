// Outcome-ledger reconciliation: a faithful port of
// apps/gateway/src/jobs/outcomeLedger.ts — the same INSERT...SELECT with
// ON CONFLICT (task_id) DO NOTHING and the same verdict backfill sweep.
// Idempotent: re-runs, crashes and races can't duplicate rows.
package daemon

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ReconcileTaskOutcomes runs one reconcile pass and returns
// {materialized, verdict_backfilled}.
func ReconcileTaskOutcomes(ctx context.Context, pool *pgxpool.Pool) (map[string]int64, error) {
	out := map[string]int64{}

	// 1) Terminal tasks not yet materialized. LEFT JOIN agents: the agent
	// row may already be purged (is_native denormalizes to false then).
	// created_at copies the TASK's creation time. The runId CASE guard
	// (regex + EXISTS) is verbatim — one malformed string must never fail
	// the batch or violate the native_runs reference.
	rows, err := pool.Query(ctx, `
		INSERT INTO task_outcomes
			(task_id, context_id, target_agent_id, caller_agent_id,
			 target_is_native, caller_is_native, state, latency_ms, source_run_id, created_at)
		SELECT t.id, t.context_id, t.target_agent_id, t.caller_agent_id,
		       COALESCE(ta.is_native, false),
		       COALESCE(ca.is_native, false),
		       t.state,
		       GREATEST(0, (EXTRACT(EPOCH FROM (t.updated_at - t.created_at)) * 1000)::int),
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
	`)
	if err != nil {
		return out, err
	}
	var materialized int64
	for rows.Next() {
		materialized++
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	out["materialized"] = materialized

	// 2) Verdict sweep — owner verdicts that arrived before the ledger row
	// existed. Stamps every task in a verdicted goal's context.
	tag, err := pool.Exec(ctx, `
		UPDATE task_outcomes o
		SET goal_accepted = (g.status = 'accepted')
		FROM goals g
		WHERE g.context_id = o.context_id
		  AND g.status IN ('accepted', 'rejected')
		  AND o.goal_accepted IS DISTINCT FROM (g.status = 'accepted')
	`)
	if err != nil {
		return out, err
	}
	out["verdict_backfilled"] = tag.RowsAffected()
	return out, nil
}
