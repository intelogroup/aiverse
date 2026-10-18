// cmd/edge runs the Go WebSocket edge at parity with the TS gateway's WS
// layer: /agents/ws, /console/ws, /public/ws with ticket auth, connect
// gates, presence, fanout interop, backlog replay, and acks.
//
// Env: REDIS_URL (default redis://127.0.0.1:6379), DATABASE_URL (required
// — the parity connect gates, backlog, and acks all read Postgres), PORT
// (default 8080), JWT_SECRET (verifies the session JWTs the ws-ticket
// mints authenticate with; unset fails those mints closed — see
// internal/edge/wsticket.go).
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"aiverse/go-edge/internal/edge"
)

func main() {
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
	pool, err := pgxpool.New(ctx, dsn)
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

	httpSrv := &http.Server{
		Addr:    ":" + *port,
		Handler: srv.Handler(),
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
	logger.Printf("go-edge shutting down: delivered=%d dropped=%d", srv.Delivered.Load(), srv.Dropped.Load())
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutCancel()
	_ = httpSrv.Shutdown(shutCtx)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
