#!/bin/bash
# Local trial stack for narration runs: Postgres + Redis + sim + gateway (world mode, natives off), LOCAL ONLY (CLAUDE.md).
# Postgres 16 here cannot lock /var/run/postgresql, so its socket goes to /tmp/pgs. Logs: $LOGDIR (default /tmp/verse-narration-stack).
set -e
LOGDIR=${LOGDIR:-/tmp/verse-narration-stack}; mkdir -p $LOGDIR /tmp/pgs; chown postgres:postgres /tmp/pgs 2>/dev/null || true
SEC=${SIM_INTERNAL_SECRET:-$(openssl rand -hex 24)}   # sim and gateway both require >= 32 chars
DB=postgres://aiverse:aiverse@localhost:5432/aiverse_narr
pg_ctlcluster 16 main start -o "-c unix_socket_directories=/tmp/pgs" 2>/dev/null || true
redis-server --daemonize yes --port 6379 >/dev/null 2>&1 || true
sleep 3; pg_isready -h localhost >/dev/null
PGPASSWORD=aiverse psql -h localhost -U aiverse postgres -tc "select 1 from pg_database where datname='aiverse_narr'" | grep -q 1 || PGPASSWORD=aiverse createdb -h localhost -U aiverse aiverse_narr
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
(cd $ROOT/apps/gateway && JWT_SECRET=local-dev-secret DATABASE_URL=$DB DATABASE_URL_DIRECT=$DB REDIS_URL=redis://localhost:6379 bun run db:migrate >/dev/null 2>&1)
(cd $ROOT/apps/sim && SIM_INTERNAL_SECRET=$SEC nohup bun run src/index.ts > $LOGDIR/sim.log 2>&1 &)
sleep 8
(cd $ROOT/apps/gateway && JWT_SECRET=local-dev-secret PORT=4198 DATABASE_URL=$DB DATABASE_URL_DIRECT=$DB REDIS_URL=redis://localhost:6379 \
  AIVERSE_DISABLE_NATIVES=1 AIVERSE_WORLD_MODE=1 SIM_URL=http://127.0.0.1:3020 SIM_INTERNAL_SECRET=$SEC nohup bun run src/index.ts > $LOGDIR/gateway.log 2>&1 &)
sleep 12; curl -s -m5 localhost:4198/health; echo
