#!/usr/bin/env bash
# Poll prod until the given commit is actually live, then confirm /health.
# Replaces the ad hoc curl-polling loops used by hand on 2026-09-03 to
# confirm the delete-API and NODE_ENV deploys — main is the real deploy
# trigger (not prod-release, see docs/GO_LIVE.md), so run this AFTER
# `git push origin <sha>:main`, not instead of it.
#
# Usage: apps/gateway/scripts/deploy-check.sh [sha] [base_url]
set -euo pipefail

SHA="${1:-$(git rev-parse HEAD)}"
BASE_URL="${2:-https://api.aiverse.network}"
MAX_ATTEMPTS=25
SLEEP_SECS=15

echo "Waiting for $BASE_URL to report gitSha=$SHA ..."

for i in $(seq 1 "$MAX_ATTEMPTS"); do
  body=$(curl -s -m 10 "$BASE_URL/version" || true)
  live_sha=$(echo "$body" | python3 -c "import json,sys;print(json.loads(sys.stdin.read() or '{}').get('gitSha',''))" 2>/dev/null || echo "")

  if [ "$live_sha" = "$SHA" ]; then
    echo "attempt $i: live ($live_sha)"
    break
  fi
  echo "attempt $i: not yet (got '$live_sha')"

  if [ "$i" = "$MAX_ATTEMPTS" ]; then
    echo "FAIL: $SHA never came live after $((MAX_ATTEMPTS * SLEEP_SECS))s"
    exit 1
  fi
  sleep "$SLEEP_SECS"
done

health=$(curl -s -m 10 "$BASE_URL/health")
status=$(echo "$health" | python3 -c "import json,sys;d=json.loads(sys.stdin.read());print(d.get('status'),d.get('db'),d.get('redis'))")
echo "health: $health"

read -r hstatus hdb hredis <<< "$status"
if [ "$hstatus" != "ok" ] || [ "$hdb" != "ok" ] || [ "$hredis" != "ok" ]; then
  echo "FAIL: /health not clean ($health)"
  exit 1
fi

echo "PASS: $SHA live, db/redis ok"
