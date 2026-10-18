// cmd/daemons runs the singleton background jobs under the leader lock:
// GC (boot + 24h), outcome-ledger reconcile (boot + hourly), the native
// tick scheduler (90s + 0–60s jitter, intents only — tick body stays TS),
// the 15s leadership watchdog, and 15s follower failover retry — the same
// shape as apps/gateway/src/index.ts + db/singleGatewayLock.ts.
//
// Env: DATABASE_URL (jobs pool), DATABASE_URL_DIRECT (lock session;
// falls back to DATABASE_URL), REDIS_URL.
// Flags: -once runs GC + ledger a single time (as leader) and exits.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"aiverse/go-edge/internal/daemon"
)

var logger = log.New(os.Stdout, "", log.LstdFlags|log.Lmicroseconds)

func logEvent(event string, fields map[string]any) {
	m := map[string]any{"event": event}
	for k, v := range fields {
		m[k] = v
	}
	raw, _ := json.Marshal(m)
	logger.Print(string(raw))
}

func main() {
	once := flag.Bool("once", false, "acquire leadership, run GC + ledger once, print JSON, exit")
	gcInterval := flag.Duration("gc-interval", 24*time.Hour, "GC interval")
	ledgerInterval := flag.Duration("ledger-interval", time.Hour, "outcome-ledger interval")
	checkInterval := flag.Duration("check-interval", 15*time.Second, "leader check / follower retry interval")
	withTick := flag.Bool("tick", true, "run the native tick intent scheduler")
	tickBase := flag.Duration("tick-base", 90*time.Second, "tick base interval")
	tickJitter := flag.Duration("tick-jitter", 60*time.Second, "tick jitter (uniform 0..jitter)")
	flag.Parse()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	jobDSN := envOr("DATABASE_URL", "")
	lockDSN := envOr("DATABASE_URL_DIRECT", jobDSN)
	if lockDSN == "" {
		log.Fatalf("DATABASE_URL (or DATABASE_URL_DIRECT) is required")
	}
	pool, err := pgxpool.New(ctx, jobDSN)
	if err != nil {
		log.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	lock, acquired, err := daemon.TryAcquire(ctx, lockDSN, 30*time.Second)
	if err != nil {
		log.Fatalf("leader lock: %v", err)
	}

	if *once {
		if !acquired {
			logEvent("gateway_role", map[string]any{"leader": false, "once": true})
			fmt.Fprintln(os.Stderr, "not leader; -once requires leadership")
			os.Exit(1)
		}
		defer lock.Close()
		gcOut, gcErr := daemon.RunGC(ctx, pool)
		ledgerOut, ledgerErr := daemon.ReconcileTaskOutcomes(ctx, pool)
		result := map[string]any{"gc": gcOut, "ledger": ledgerOut}
		if gcErr != nil {
			result["gc_error"] = gcErr.Error()
			logEvent("gc_error", map[string]any{"error": gcErr.Error()})
		} else {
			logEvent("gc_run", map[string]any{"counts": gcOut})
		}
		if ledgerErr != nil {
			result["ledger_error"] = ledgerErr.Error()
			logEvent("outcome_ledger_error", map[string]any{"error": ledgerErr.Error()})
		} else if ledgerOut["materialized"] > 0 || ledgerOut["verdict_backfilled"] > 0 {
			logEvent("outcome_ledger_reconcile", map[string]any{"counts": ledgerOut})
		}
		raw, _ := json.Marshal(result)
		fmt.Println(string(raw))
		if gcErr != nil || ledgerErr != nil {
			os.Exit(1)
		}
		return
	}

	// Long-running mode (index.ts shape): serve as follower until leader.
	jobsCtx, jobsCancel := context.WithCancel(ctx)
	var lockHolder = lock
	jobsStarted := false
	startJobs := func() {
		if jobsStarted {
			return
		}
		jobsStarted = true
		go runIntervals(jobsCtx, pool, *gcInterval, *ledgerInterval)
		if *withTick {
			rdb := redisClient()
			sched := &daemon.TickScheduler{RDB: rdb, Base: *tickBase, Jitter: *tickJitter, Logger: logger}
			go sched.Run(jobsCtx)
		}
		go watchdog(jobsCtx, lockHolder, *checkInterval)
	}

	if acquired {
		logEvent("gateway_leader_acquired", map[string]any{"key": fmt.Sprint(daemon.LockKey)})
		logEvent("gateway_role", map[string]any{"leader": true})
		startJobs()
	} else {
		logEvent("gateway_role", map[string]any{"leader": false})
		go func() {
			ticker := time.NewTicker(*checkInterval)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
				l, ok, err := daemon.TryAcquire(ctx, lockDSN, 0)
				if err != nil {
					logEvent("gateway_leader_retry_error", map[string]any{"error": err.Error()})
					continue
				}
				if ok {
					lockHolder = l
					logEvent("gateway_leader_failover", map[string]any{})
					logEvent("gateway_role", map[string]any{"leader": true})
					startJobs()
					return
				}
			}
		}()
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	jobsCancel()
	if lockHolder != nil {
		lockHolder.Close()
	}
}

// watchdog: the leader re-checks every interval that its own session still
// holds the lock; exits for a supervisor restart when another process took
// it (the scheduled jobs have no stop hooks — same reasoning as index.ts).
func watchdog(ctx context.Context, lock *daemon.Lock, interval time.Duration) {
	consecutiveErrors := 0
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		status, err := lock.Check(ctx)
		if err != nil {
			consecutiveErrors++
			logEvent("gateway_leader_check_error", map[string]any{"error": err.Error(), "consecutiveErrors": consecutiveErrors})
			if consecutiveErrors >= 3 {
				logger.Print("gateway_leader_check_fatal: 3 consecutive errors, exiting")
				os.Exit(1)
			}
			continue
		}
		consecutiveErrors = 0
		switch status {
		case daemon.LockReacquired:
			logEvent("gateway_leader_reacquired", map[string]any{})
		case daemon.LockLost:
			logger.Print("gateway_leader_lost: another process holds the leader lock; exiting to stop singleton jobs")
			os.Exit(1)
		}
	}
}

// runIntervals runs GC + ledger once at start, then on their intervals
// (scheduleGc / scheduleOutcomeLedger both fire immediately at schedule).
func runIntervals(ctx context.Context, pool *pgxpool.Pool, gcEvery, ledgerEvery time.Duration) {
	if out, err := daemon.RunGC(ctx, pool); err != nil {
		logEvent("gc_error", map[string]any{"error": err.Error()})
	} else {
		logEvent("gc_run", map[string]any{"counts": out})
	}
	if out, err := daemon.ReconcileTaskOutcomes(ctx, pool); err != nil {
		logEvent("outcome_ledger_error", map[string]any{"error": err.Error()})
	} else if out["materialized"] > 0 || out["verdict_backfilled"] > 0 {
		logEvent("outcome_ledger_reconcile", map[string]any{"counts": out})
	}
	gcT := time.NewTicker(gcEvery)
	ledgerT := time.NewTicker(ledgerEvery)
	defer gcT.Stop()
	defer ledgerT.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-gcT.C:
			if out, err := daemon.RunGC(ctx, pool); err != nil {
				logEvent("gc_error", map[string]any{"error": err.Error()})
			} else {
				logEvent("gc_run", map[string]any{"counts": out})
			}
		case <-ledgerT.C:
			if out, err := daemon.ReconcileTaskOutcomes(ctx, pool); err != nil {
				logEvent("outcome_ledger_error", map[string]any{"error": err.Error()})
			} else if out["materialized"] > 0 || out["verdict_backfilled"] > 0 {
				logEvent("outcome_ledger_reconcile", map[string]any{"counts": out})
			}
		}
	}
}

func redisClient() *redis.Client {
	opt, err := redis.ParseURL(envOr("REDIS_URL", "redis://127.0.0.1:6379"))
	if err != nil {
		log.Fatalf("bad REDIS_URL: %v", err)
	}
	return redis.NewClient(opt)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
