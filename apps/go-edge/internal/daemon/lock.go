// Leader lock: a faithful port of apps/gateway/src/db/singleGatewayLock.ts.
//
// Session-scoped pg_try_advisory_lock on a dedicated connection (never a
// pool): the lock dies with the session, so a crashed leader releases it
// automatically. Exactly one process runs the singleton jobs (native ticks,
// GC, outcome ledger); everyone else serves/follows and retries.
package daemon

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// LockKey is "aiverse1" ASCII as a signed bigint (0x6169766572736531).
const LockKey int64 = 0x6169766572736531

// Lock owns the dedicated session holding the advisory lock.
type Lock struct {
	conn *pgx.Conn
}

// TryAcquire attempts pg_try_advisory_lock on a fresh dedicated connection,
// retrying every 1s until timeout elapses (timeout=0 → exactly one attempt,
// what the follower failover loop uses). Returns (nil, false) when another
// process holds the lock — a normal outcome, not an error.
func TryAcquire(ctx context.Context, dsn string, timeout time.Duration) (*Lock, bool, error) {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return nil, false, err
	}
	deadline := time.Now().Add(timeout)
	for {
		var ok bool
		// The key travels as a bigint parameter; TS passes text and casts —
		// same exactness concern (value > 2^53), pgx encodes int64 natively.
		err := conn.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", LockKey).Scan(&ok)
		if err != nil {
			_ = conn.Close(context.Background())
			return nil, false, err
		}
		if ok {
			return &Lock{conn: conn}, true, nil
		}
		if !time.Now().Before(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			_ = conn.Close(context.Background())
			return nil, false, ctx.Err()
		case <-time.After(1 * time.Second):
		}
	}
	_ = conn.Close(context.Background())
	return nil, false, nil
}

// Status of a leadership self-check.
type LockStatus string

const (
	LockHeld       LockStatus = "held"
	LockReacquired LockStatus = "reacquired"
	LockLost       LockStatus = "lost"
)

// Check asks Postgres whether THIS session's backend still holds the
// advisory lock (a bare "select 1" can't distinguish — a reconnected session
// holds nothing). If free, tries to take it back on the same session.
func (l *Lock) Check(ctx context.Context) (LockStatus, error) {
	var n int
	err := l.conn.QueryRow(ctx, `
		SELECT count(*) FROM pg_locks
		WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
	`).Scan(&n)
	if err != nil {
		return "", err
	}
	if n > 0 {
		return LockHeld, nil
	}
	var ok bool
	err = l.conn.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", LockKey).Scan(&ok)
	if err != nil {
		return "", err
	}
	if ok {
		return LockReacquired, nil
	}
	return LockLost, nil
}

// BackendPID is this lock session's backend pid (diagnostics/tests).
func (l *Lock) BackendPID(ctx context.Context) (int, error) {
	var pid int
	err := l.conn.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid)
	return pid, err
}

// Close ends the session, releasing the lock.
func (l *Lock) Close() {
	if l.conn != nil {
		_ = l.conn.Close(context.Background())
	}
}
