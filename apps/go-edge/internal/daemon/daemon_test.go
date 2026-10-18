package daemon

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"aiverse/go-edge/internal/verse"
)

// Integration tests against the local bench stack (Postgres aiverse_bench
// + Redis on 127.0.0.1). They skip when the stack is unreachable.

func testDSN() string {
	if v := os.Getenv("GO_EDGE_TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://postgres:postgres@127.0.0.1:5432/aiverse_bench"
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, testDSN())
	if err != nil {
		t.Skipf("pgxpool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestLockExclusivity(t *testing.T) {
	ctx := context.Background()
	dsn := testDSN()

	a, ok, err := TryAcquire(ctx, dsn, 2*time.Second)
	if err != nil {
		t.Skipf("lock acquire (db unreachable?): %v", err)
	}
	if !ok {
		t.Fatal("first acquire should win on a free lock")
	}
	defer a.Close()

	// A second process/session cannot take it (single attempt).
	b, okB, err := TryAcquire(ctx, dsn, 0)
	if err != nil {
		t.Fatalf("second acquire err: %v", err)
	}
	if okB {
		b.Close()
		t.Fatal("second acquire must NOT win while the first holds the lock")
	}

	status, err := a.Check(ctx)
	if err != nil {
		t.Fatalf("leader check: %v", err)
	}
	if status != LockHeld {
		t.Fatalf("leader check = %q, want held", status)
	}

	// Release: the lock dies with the session, a follower takes over.
	a.Close()
	c, okC, err := TryAcquire(ctx, dsn, 5*time.Second)
	if err != nil {
		t.Fatalf("post-release acquire err: %v", err)
	}
	if !okC {
		t.Fatal("acquire after leader session closed should win")
	}
	defer c.Close()
	status, err = c.Check(ctx)
	if err != nil || status != LockHeld {
		t.Fatalf("successor check = %q err=%v, want held", status, err)
	}
}

func TestTickIntentDispatch(t *testing.T) {
	rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:6379"})
	defer rdb.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Skipf("redis unavailable: %v", err)
	}
	sched := &TickScheduler{RDB: rdb}
	id, err := sched.DispatchTick(ctx)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	entries, err := rdb.XRange(ctx, verse.TickIntentsStream, id, id).Result()
	if err != nil || len(entries) != 1 {
		t.Fatalf("xrange intent: err=%v entries=%d", err, len(entries))
	}
	raw, _ := entries[0].Values["intent"].(string)
	var intent struct {
		NativeRun bool  `json:"nativeRun"`
		At        int64 `json:"at"`
	}
	if err := json.Unmarshal([]byte(raw), &intent); err != nil {
		t.Fatalf("intent json: %v (%q)", err, raw)
	}
	if !intent.NativeRun || intent.At <= 0 {
		t.Fatalf("intent = %+v, want nativeRun=true and at>0", intent)
	}
	rdb.XDel(ctx, verse.TickIntentsStream, id)
}

// Ledger runs before the GC test in this file: on a fresh bench DB its
// counts are exact; the assertions below key on this test's own task ids
// so leftovers from earlier bench runs can't flake it.
func TestLedgerReconcileIdempotent(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	ownerID, agentA, agentB := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO owners (id, email, password_hash) VALUES ($1, $2, 'x')`,
		ownerID, "ledger-"+ownerID[:8]+"@bench.local"); err != nil {
		t.Skipf("schema not applied? %v", err)
	}
	for _, a := range []struct {
		id   string
		name string
	}{{agentA, "LedgerA"}, {agentB, "LedgerB"}} {
		if _, err := pool.Exec(ctx, `INSERT INTO agents (id, owner_id, name, api_key_hash, status) VALUES ($1, $2, $3, 'h', 'offline')`,
			a.id, ownerID, a.name); err != nil {
			t.Fatalf("seed agent: %v", err)
		}
	}
	taskIDs := make([]string, 5)
	for i := range taskIDs {
		taskIDs[i] = uuid.NewString()
		if _, err := pool.Exec(ctx, `
			INSERT INTO a2a_tasks (id, target_agent_id, caller_agent_id, state, request_message, created_at, updated_at)
			VALUES ($1, $2, $3, 'completed', '{}'::jsonb, now() - interval '1 hour', now())
		`, taskIDs[i], agentA, agentB); err != nil {
			t.Fatalf("seed task: %v", err)
		}
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `DELETE FROM task_outcomes WHERE task_id = ANY($1::uuid[])`, taskIDs)
		pool.Exec(ctx, `DELETE FROM a2a_tasks WHERE id = ANY($1::uuid[])`, taskIDs)
		pool.Exec(ctx, `DELETE FROM agents WHERE id = ANY($1::uuid[])`, []string{agentA, agentB})
		pool.Exec(ctx, `DELETE FROM owners WHERE id = $1`, ownerID)
	})

	out, err := ReconcileTaskOutcomes(ctx, pool)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if out["materialized"] < 5 {
		t.Fatalf("materialized = %d, want >= 5", out["materialized"])
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM task_outcomes WHERE task_id = ANY($1::uuid[])`, taskIDs).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 5 {
		t.Fatalf("task_outcomes for seeded tasks = %d, want 5", n)
	}

	// Re-run: ON CONFLICT DO NOTHING keeps it at exactly 5.
	if _, err := ReconcileTaskOutcomes(ctx, pool); err != nil {
		t.Fatalf("reconcile #2: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM task_outcomes WHERE task_id = ANY($1::uuid[])`, taskIDs).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 5 {
		t.Fatalf("task_outcomes after re-run = %d, want 5 (idempotent)", n)
	}
}

func TestGCMessageRecount(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	ownerID, agentID, convID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO owners (id, email, password_hash) VALUES ($1, $2, 'x')`,
		ownerID, "gc-"+ownerID[:8]+"@bench.local"); err != nil {
		t.Skipf("schema not applied? %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agents (id, owner_id, name, api_key_hash, status) VALUES ($1, $2, 'GCAgent', 'h', 'offline')`,
		agentID, ownerID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO conversations (id, kind, message_count) VALUES ($1, 'room', 5)`, convID); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	// 3 aged (>90d, GC deletes) + 2 fresh (GC keeps).
	for i := 0; i < 3; i++ {
		if _, err := pool.Exec(ctx, `INSERT INTO messages (id, conversation_id, sender_agent_id, content, created_at)
			VALUES ($1, $2, $3, 'aged', now() - interval '100 days')`, uuid.NewString(), convID, agentID); err != nil {
			t.Fatalf("seed aged message: %v", err)
		}
	}
	for i := 0; i < 2; i++ {
		if _, err := pool.Exec(ctx, `INSERT INTO messages (id, conversation_id, sender_agent_id, content, created_at)
			VALUES ($1, $2, $3, 'fresh', now())`, uuid.NewString(), convID, agentID); err != nil {
			t.Fatalf("seed fresh message: %v", err)
		}
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `DELETE FROM messages WHERE conversation_id = $1`, convID)
		pool.Exec(ctx, `DELETE FROM conversations WHERE id = $1`, convID)
		pool.Exec(ctx, `DELETE FROM agents WHERE id = $1`, agentID)
		pool.Exec(ctx, `DELETE FROM owners WHERE id = $1`, ownerID)
	})

	out, err := RunGC(ctx, pool)
	if err != nil {
		t.Fatalf("run gc: %v", err)
	}
	if out["messages_old_deleted"] < 3 {
		t.Fatalf("messages_old_deleted = %d, want >= 3", out["messages_old_deleted"])
	}
	var remaining, count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM messages WHERE conversation_id = $1`, convID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 2 {
		t.Fatalf("messages remaining = %d, want 2", remaining)
	}
	if err := pool.QueryRow(ctx, `SELECT message_count FROM conversations WHERE id = $1`, convID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("conversations.message_count = %d, want exactly 2 after recount", count)
	}
}
