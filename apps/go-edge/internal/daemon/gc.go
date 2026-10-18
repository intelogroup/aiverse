// Lifecycle GC: a faithful port of apps/gateway/src/jobs/gc.ts — same
// policies, same batching (id-CTE DELETE, batch 5000, max 20 batches/pass),
// same conversations.message_count recount discipline (separate UPDATE
// after the delete, never in the same statement — snapshot semantics).
package daemon

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	gcBatchSize  = 5000
	gcMaxBatches = 20
)

// BatchedDelete deletes rows older than maxAge (a Postgres interval literal
// like "90 days") in bounded batches. whereExtra is an additional raw
// condition ANDed in — fixed call-site literals only, exactly as in gc.ts.
func BatchedDelete(ctx context.Context, pool *pgxpool.Pool, table, maxAge string, whereExtra string) (int64, error) {
	var total int64
	for i := 0; i < gcMaxBatches; i++ {
		extra := ""
		if whereExtra != "" {
			extra = " AND " + whereExtra
		}
		returning := "1"
		if table == "messages" {
			returning = "conversation_id"
		}
		q := fmt.Sprintf(
			`WITH del AS (DELETE FROM %s WHERE id IN (SELECT id FROM %s WHERE created_at < now() - interval '%s'%s LIMIT %d) RETURNING %s) SELECT * FROM del`,
			table, table, maxAge, extra, gcBatchSize, returning,
		)
		rows, err := pool.Query(ctx, q)
		if err != nil {
			return total, err
		}
		var convIDs []string
		var n int64
		for rows.Next() {
			n++
			if table == "messages" {
				var cid string
				if err := rows.Scan(&cid); err != nil {
					rows.Close()
					return total, err
				}
				convIDs = append(convIDs, cid)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return total, err
		}
		total += n
		if table == "messages" && n > 0 {
			// Recount SECOND, separately (migration 0034 note in gc.ts): the
			// denormalized conversations.message_count must stay exact.
			seen := make(map[string]struct{})
			ids := make([]string, 0, len(convIDs))
			for _, id := range convIDs {
				if _, dup := seen[id]; !dup {
					seen[id] = struct{}{}
					ids = append(ids, id)
				}
			}
			_, err := pool.Exec(ctx, `
				UPDATE conversations
				SET message_count = (SELECT count(*) FROM messages m WHERE m.conversation_id = conversations.id)
				WHERE id = ANY($1::uuid[])
			`, ids)
			if err != nil {
				return total, err
			}
		}
		if n < gcBatchSize {
			break
		}
	}
	return total, nil
}

// RunGC executes one full GC pass and returns per-policy counts. Like
// gc.ts, the first error aborts the pass and the counts gathered so far
// are returned alongside it.
func RunGC(ctx context.Context, pool *pgxpool.Pool) (map[string]int64, error) {
	out := map[string]int64{}

	// 1) Unclaimed agents expired >48h — delete children first (no CASCADE).
	var probeIDs []string
	rows, err := pool.Query(ctx, `
		SELECT id FROM agents
		WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours'
		LIMIT 1000
	`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return out, err
		}
		probeIDs = append(probeIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	if len(probeIDs) > 0 {
		const pred = `agent_id IN (SELECT id FROM agents WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours')`
		for _, tbl := range []string{"agent_wallets", "agent_policy_scope", "console_events", "security_events"} {
			if _, err := pool.Exec(ctx, "DELETE FROM "+tbl+" WHERE "+pred); err != nil {
				return out, err
			}
		}
		tag, err := pool.Exec(ctx, `
			DELETE FROM agents
			WHERE status='unclaimed' AND claim_code_expires_at < now() - interval '48 hours'
		`)
		if err != nil {
			return out, err
		}
		out["unclaimed_purged"] = tag.RowsAffected()
	} else {
		out["unclaimed_purged"] = 0
	}

	// 2) Stuck submitted tasks >7d → canceled.
	tag, err := pool.Exec(ctx, `
		UPDATE a2a_tasks SET state='canceled', updated_at=now()
		WHERE state='submitted' AND created_at < now() - interval '7 days'
	`)
	if err != nil {
		return out, err
	}
	out["tasks_stuck_canceled"] = tag.RowsAffected()

	// 3) Old tasks >30d → delete. NEVER task_outcomes (ledger outlives tasks).
	if out["tasks_old_deleted"], err = BatchedDelete(ctx, pool, "a2a_tasks", "30 days", ""); err != nil {
		return out, err
	}
	// 4) Old messages >90d.
	if out["messages_old_deleted"], err = BatchedDelete(ctx, pool, "messages", "90 days", ""); err != nil {
		return out, err
	}
	// 5) Old console_events >90d.
	if out["console_old_deleted"], err = BatchedDelete(ctx, pool, "console_events", "90 days", ""); err != nil {
		return out, err
	}
	// 6) security_events >90d.
	if out["security_old_deleted"], err = BatchedDelete(ctx, pool, "security_events", "90 days", ""); err != nil {
		return out, err
	}
	// 7) agent_memory >90d, non-goal rows only.
	if out["agent_memory_old_deleted"], err = BatchedDelete(ctx, pool, "agent_memory", "90 days", "goal_id IS NULL"); err != nil {
		return out, err
	}
	return out, nil
}
