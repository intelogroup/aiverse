#!/usr/bin/env bash
# dev_down.sh — stop the local dev stack (gateway, scratch Postgres,
# scratch Redis). Data dirs and logs are kept; dev_up.sh re-boots.
set -uo pipefail

DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGROOT=/tmp/agentsenses-pg
PGDATA=/tmp/agentsenses-pgdata
PGBIN=$PGROOT/usr/lib/postgresql/16/bin
export LD_LIBRARY_PATH=$PGROOT/usr/lib/x86_64-linux-gnu
REDIS_DIR=/tmp/redis-7.2.5

if [ -f "$DEV_DIR/gateway.pid" ]; then
  kill "$(cat "$DEV_DIR/gateway.pid")" 2>/dev/null || true
  rm -f "$DEV_DIR/gateway.pid"
fi
if [ -f "$DEV_DIR/sim.pid" ]; then
  kill "$(cat "$DEV_DIR/sim.pid")" 2>/dev/null || true
  rm -f "$DEV_DIR/sim.pid"
fi
echo "sim: stopped"
# Belt and braces: pid files can drift (setsid re-parents) and a plain
# pkill missed a live gateway once (2026-11-14), so sweep by cwd: kill
# any bun process running from the worktree's gateway/sim dirs.
WT="$HOME/workspace/.build-tmp/aiverse-test"
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue
  case "$cwd" in
    "$WT/apps/gateway"|"$WT/apps/sim")
      kill "$pid" 2>/dev/null && echo "swept bun $pid ($cwd)" ;;
  esac
done
echo "gateway: stopped"

if $PGBIN/pg_isready -h 127.0.0.1 -p 5434 >/dev/null 2>&1; then
  setpriv --reuid=65534 --regid=65534 --clear-groups \
    env LD_LIBRARY_PATH="$LD_LIBRARY_PATH" \
    "$PGBIN/pg_ctl" -D "$PGDATA" stop -m fast || true
fi
echo "postgres: stopped"

if [ -x "$REDIS_DIR/src/redis-cli" ]; then
  $REDIS_DIR/src/redis-cli -p 6379 shutdown nosave 2>/dev/null || true
fi
echo "redis: stopped"
