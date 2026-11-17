#!/usr/bin/env bash
# dev_up.sh — boot the LOCAL AIVerse dev stack for the agent-senses
# program (Jim, 2026-11-14: a dev way that needs no human tap, for
# testing only). Idempotent: safe to re-run; pieces already up are
# left alone.
#
#   scratch Postgres 16 on 127.0.0.1:5434 (db aiverse_test, UTC)
#   scratch Redis on 127.0.0.1:6379
#   gateway from ~/workspace/.build-tmp/aiverse-test (main 4ca120d5)
#     on http://localhost:3100, NODE_ENV=test, natives mocked
#
# Production is never touched: everything lives under /tmp and the
# gateway talks only to the scratch DB/Redis.
set -euo pipefail

DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${AIVERSE_REPO:-$HOME/workspace/.build-tmp/aiverse-test}"
# Runtime state lives in /tmp ON PURPOSE: Postgres must run as the
# nobody user, and this VM's uid mapping gives nobody no access at
# all under /home — while /tmp is wiped whenever the VM restarts.
# So /tmp holds only rebuildable runtime state; every durable source
# (Postgres binaries in ~/workspace/.postgres, the built Redis in
# dev/stack/) lives in the workspace and is copied/rebuilt from here.
PGROOT=/tmp/agentsenses-pg
PGDATA=/tmp/agentsenses-pgdata
PGBIN=$PGROOT/usr/lib/postgresql/16/bin
export LD_LIBRARY_PATH=$PGROOT/usr/lib/x86_64-linux-gnu
REDIS_DIR=/tmp/redis-7.2.5
REDIS_CACHE=$DEV_DIR/stack/redis-7.2.5
GW_PORT=3100

pg_as_nobody() {
  setpriv --reuid=65534 --regid=65534 --clear-groups \
    env LD_LIBRARY_PATH="$LD_LIBRARY_PATH" "$@"
}

# --- Postgres -------------------------------------------------------
if ! $PGBIN/pg_isready -h 127.0.0.1 -p 5434 >/dev/null 2>&1; then
  if [ ! -x "$PGBIN/initdb" ]; then
    rm -rf "$PGROOT"
    cp -r "$HOME/workspace/.postgres" "$PGROOT"
    chmod -R a+rX "$PGROOT"
  fi
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    rm -rf "$PGDATA"
    mkdir -p "$PGDATA"
    chown 65534:65534 "$PGDATA"
    chmod 700 "$PGDATA"
    pg_as_nobody "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust
    printf "port = 5434\nlisten_addresses = '127.0.0.1'\ntimezone = 'UTC'\nunix_socket_directories = '%s'\n" \
      "$PGDATA" >> "$PGDATA/postgresql.conf"
  fi
  pg_as_nobody "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" start
fi
$PGBIN/psql -h 127.0.0.1 -p 5434 -U postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname='aiverse_test'" | grep -q 1 || \
  $PGBIN/createdb -h 127.0.0.1 -p 5434 -U postgres aiverse_test
echo "postgres: up on 5434 (db aiverse_test)"

# --- Redis ------------------------------------------------------------
if ! $REDIS_DIR/src/redis-cli -p 6379 ping >/dev/null 2>&1; then
  if [ ! -x "$REDIS_DIR/src/redis-server" ]; then
    if [ ! -x "$REDIS_CACHE/src/redis-server" ]; then
      (cd "$DEV_DIR/stack" && curl -fsSLO https://download.redis.io/releases/redis-7.2.5.tar.gz \
        && tar xzf redis-7.2.5.tar.gz \
        && cd redis-7.2.5 && make -j2 MALLOC=libc >/dev/null)
    fi
    rm -rf "$REDIS_DIR"
    cp -r "$REDIS_CACHE" "$REDIS_DIR"
    chmod -R a+rX "$REDIS_DIR"
  fi
  $REDIS_DIR/src/redis-server --port 6379 --daemonize yes \
    --save '' --appendonly no --dir /tmp
fi
echo "redis: up on 6379"

# --- Sim (apps/sim: the world service the gateway reaches) ---------------
# The gateway mounts /world/* only with AIVERSE_WORLD_MODE=1 + SIM_URL +
# SIM_INTERNAL_SECRET (>= 32 chars); the sim wants the same secret.
SIM_SECRET="$(printf 'dev-sim-%s' '0123456789abcdef0123456789abcdef0123456789abcdef')"
SIM_PORT=3020
sim_alive() {
  [ -f "$DEV_DIR/sim.pid" ] && \
    kill -0 "$(cat "$DEV_DIR/sim.pid")" 2>/dev/null
}
if ! sim_alive; then
  : > "$DEV_DIR/sim.log"
  (cd "$REPO/apps/sim" && SIM_INTERNAL_SECRET="$SIM_SECRET" \
    SIM_PORT=$SIM_PORT setsid nohup bun src/index.ts \
    > "$DEV_DIR/sim.log" 2>&1 < /dev/null & echo $! > "$DEV_DIR/sim.pid")
  for i in $(seq 1 90); do
    if grep -q sim_listening "$DEV_DIR/sim.log" 2>/dev/null; then
      break
    fi
    if ! sim_alive; then
      echo "sim died during boot; see $DEV_DIR/sim.log" >&2
      exit 1
    fi
    sleep 2
  done
fi
grep -q sim_listening "$DEV_DIR/sim.log" || {
  echo "sim did not reach listening; see $DEV_DIR/sim.log" >&2; exit 1; }
echo "sim: up on http://127.0.0.1:$SIM_PORT"

# --- Gateway env --------------------------------------------------------
export NODE_ENV=test
export AIVERSE_WORLD_MODE=1
export SIM_URL=http://127.0.0.1:$SIM_PORT
export SIM_INTERNAL_SECRET="$SIM_SECRET"
# Dummy local-only secrets, assembled at runtime (never real values).
export JWT_SECRET="$(printf 'dev-jwt-%s' '0123456789abcdef0123456789abcdef')"
export DATABASE_URL=postgres://postgres@127.0.0.1:5434/aiverse_test
export DATABASE_URL_DIRECT=$DATABASE_URL
export REDIS_URL=redis://127.0.0.1:6379
export PUBLIC_BASE_URL=http://localhost:$GW_PORT
export CONSOLE_ORIGINS=http://localhost:5183
export NATIVE_LLM_MODE=mock
export INTERNAL_FORWARD_SECRET="$(printf 'dev-fwd-%s' '0123456789abcdef0123456789abcdef')"
export PORT=$GW_PORT

# --- Migrations -----------------------------------------------------------
(cd "$REPO/apps/gateway" && bun run src/db/migrate.ts)
echo "migrations: applied"

# --- Gateway ----------------------------------------------------------------
if ! curl -fsS -m 5 "http://localhost:$GW_PORT/health" >/dev/null 2>&1; then
  # setsid: the gateway must live in its own session so it survives
  # the caller's process tree (an agent exec session reaps its whole
  # tree on teardown — that killed the first boot, 2026-11-14).
  (cd "$REPO/apps/gateway" && setsid nohup bun src/index.ts \
    > "$DEV_DIR/gateway.log" 2>&1 < /dev/null & echo $! > "$DEV_DIR/gateway.pid")
  for i in $(seq 1 90); do
    if curl -fsS -m 5 "http://localhost:$GW_PORT/health" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
fi
curl -fsS -m 5 "http://localhost:$GW_PORT/health" >/dev/null
echo "gateway: up on http://localhost:$GW_PORT"
curl -fsS -m 5 "http://localhost:$GW_PORT/version" || true
echo
echo "dev stack ready. Harness: AIVERSE_GATEWAY_BASE=http://localhost:$GW_PORT python3 harness/e1.py <smoke|pilot> --dev-local"
