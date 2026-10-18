// cmd/edge runs the Go WebSocket edge at parity with the TS gateway's WS
// layer: /agents/ws, /console/ws, /public/ws with ticket auth, connect
// gates, presence, fanout interop, backlog replay, and acks.
//
// Env: REDIS_URL (default redis://127.0.0.1:6379), DATABASE_URL (required
// — the parity connect gates, backlog, and acks all read Postgres), PORT
// (default 8080), JWT_SECRET (verifies the session JWTs the ws-ticket
// mints authenticate with; unset fails those mints closed — see
// internal/edge/wsticket.go), AIVERSE_PG_POOL_MAX (Postgres pool ceiling,
// default 48), AIVERSE_GOMEMLIMIT_MB (Go runtime soft memory limit in
// MB — see decideMemoryLimit; unset leaves the runtime default, i.e. no
// limit, and the boot log says so).
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"aiverse/go-edge/internal/edge"
)

func main() {
	// Memory limit first, before anything allocates in earnest: the
	// soft limit only steers GC, so applying it early costs nothing.
	dec := decideMemoryLimit(os.Getenv("AIVERSE_GOMEMLIMIT_MB"))
	if dec.apply {
		debug.SetMemoryLimit(dec.bytes)
	}
	log.Printf("gomemlimit: %s", dec.note)

	port := flag.String("port", envOr("PORT", "8080"), "listen port")
	flag.Parse()

	redisURL := envOr("REDIS_URL", "redis://127.0.0.1:6379")
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatalf("bad REDIS_URL: %v", err)
	}
	rdb := redis.NewClient(opt)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatalf("redis ping: %v", err)
	}

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required (parity connect gates read Postgres)")
	}
	// Explicit pool sizing: pgxpool's default MaxConns is max(4, NumCPU),
	// which starves the connect path (agent load + status + visit + backlog
	// queries all queue behind ~4 connections during a connect storm —
	// measured in the 8k soak, 2026-10-18). 48 leaves the connect path
	// uncontended on small hosts while staying far under Neon's pooled
	// session budget; override with AIVERSE_PG_POOL_MAX when the host or
	// the pooler budget says otherwise.
	poolCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		log.Fatalf("bad DATABASE_URL: %v", err)
	}
	poolCfg.MaxConns = int32(envIntOr("AIVERSE_PG_POOL_MAX", 48))
	poolCfg.MaxConnIdleTime = 5 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		log.Fatalf("bad DATABASE_URL: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("postgres ping: %v", err)
	}

	logger := log.New(os.Stdout, "", log.LstdFlags|log.Lmicroseconds)
	srv := edge.NewServer(rdb, pool, logger)

	// Boot reconcile before serving traffic (ws/gateway.ts): demote
	// agents stuck at status='online' with no live presence key.
	if demoted, err := srv.ReconcilePresenceOnBoot(ctx); err != nil {
		log.Fatalf("presence reconcile: %v", err)
	} else if demoted > 0 {
		logger.Printf("presence_reconcile demoted=%d", demoted)
	}

	srv.StartFanout(ctx)

	// Live-heap visibility (millions plan rule 6 + Phase 2): per-node
	// live heap is a first-class scaling metric, so emit it on a fixed
	// cadence next to the live connection count — a soak can then read
	// heap-per-connection and spot GC-shaped growth directly from the
	// service log, no scraping endpoint needed.
	go func() {
		t := time.NewTicker(60 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				logger.Printf("%s", heapStatsLine(srv.ConnCount()))
			}
		}
	}()

	// Header + idle bounds only: ReadTimeout/WriteTimeout would kill
	// long-lived WebSocket connections, so they stay zero on purpose.
	httpSrv := &http.Server{
		Addr:              ":" + *port,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		logger.Printf("go-edge listening on :%s", *port)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	logger.Printf("go-edge shutting down: delivered=%d dropped=%d %s", srv.Delivered.Load(), srv.Dropped.Load(), heapStatsLine(srv.ConnCount()))
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutCancel()
	_ = httpSrv.Shutdown(shutCtx)
}

// memoryLimitDecision is the pure result of interpreting
// AIVERSE_GOMEMLIMIT_MB: whether to call debug.SetMemoryLimit, with
// what byte limit, plus the boot-log explanation either way.
//
// There is deliberately NO default limit when the env is unset. The
// edge runs on hosts an order of magnitude apart (Render Starter has
// 512 MB total RAM; a soak host has tens of GB): a hardcoded number
// sized for one would GC-thrash or pointlessly cap the other. The
// plan's rule is that the limit is SET and VISIBLE per environment —
// the deploy chooses the number, this knob honors it, and the boot
// log always states which of the three cases (set / unset / invalid)
// happened, so a missing limit is never silent.
type memoryLimitDecision struct {
	apply bool
	bytes int64
	note  string
}

func decideMemoryLimit(raw string) memoryLimitDecision {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return memoryLimitDecision{note: "AIVERSE_GOMEMLIMIT_MB unset: runtime default (no soft memory limit)"}
	}
	mb, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || mb <= 0 {
		return memoryLimitDecision{note: fmt.Sprintf("AIVERSE_GOMEMLIMIT_MB=%q invalid (want a positive integer of MB): ignored, runtime default (no soft memory limit)", raw)}
	}
	return memoryLimitDecision{
		apply: true,
		bytes: mb << 20,
		note:  fmt.Sprintf("AIVERSE_GOMEMLIMIT_MB=%d: soft memory limit applied (%d bytes)", mb, mb<<20),
	}
}

// formatHeapStats renders one runtime.MemStats snapshot as a single
// key=value line. Pure (the caller reads MemStats) so tests can pin
// the shape: the keys are the Phase 2 heap-budget vocabulary and must
// not drift between the periodic line and the shutdown line.
func formatHeapStats(ms runtime.MemStats, conns int) string {
	var lastPauseNs uint64
	if ms.NumGC > 0 {
		// PauseNs is a 256-entry ring; the most recent pause sits at
		// (NumGC+255)%256.
		lastPauseNs = ms.PauseNs[(ms.NumGC+255)%256]
	}
	return fmt.Sprintf("heap inuse_mb=%d alloc_mb=%d sys_mb=%d gc_count=%d last_gc_pause_ms=%d conns=%d",
		ms.HeapInuse>>20, ms.HeapAlloc>>20, ms.Sys>>20, ms.NumGC, lastPauseNs/1_000_000, conns)
}

func heapStatsLine(conns int) string {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return formatHeapStats(ms, conns)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envIntOr(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}
