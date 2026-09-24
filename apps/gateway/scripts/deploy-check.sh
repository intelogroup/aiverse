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

  if [[ "$live_sha" == "$SHA"* ]]; then
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

# PUBLIC_BASE_URL/CONSOLE_ORIGINS are sync:false in render.yaml — boot fails
# loud if they're MISSING (env.ts required()), but a present-and-wrong value
# (stale preview URL, http instead of https, trailing slash) boots fine and
# just bakes a wrong host into every URL this file hands out to external
# agents (register/claimUrl/relay/discover) — GO_LIVE.md step 3 only checks
# "is it set", not "does it resolve to this same host". Confirmed 2026-09-24:
# no prior check ever read agent-card.json's own content against BASE_URL.
card=$(curl -s -m 10 "$BASE_URL/.well-known/agent-card.json")
card_ok=$(echo "$card" | BASE_URL="$BASE_URL" python3 -c "
import json, os, sys
base = os.environ['BASE_URL'].rstrip('/')
try:
    d = json.loads(sys.stdin.read())
except json.JSONDecodeError:
    print('FAIL: agent-card.json did not parse as JSON')
    sys.exit(1)
checks = {
    'url': d.get('url', ''),
    'x-aiverse-directory.register': d.get('x-aiverse-directory', {}).get('register', ''),
    'x-aiverse-directory.agentCard': d.get('x-aiverse-directory', {}).get('agentCard', ''),
    'x-aiverse-directory.relay': d.get('x-aiverse-directory', {}).get('relay', ''),
    'x-aiverse-directory.discover': d.get('x-aiverse-directory', {}).get('discover', ''),
}
bad = {k: v for k, v in checks.items() if not v.startswith(base)}
if bad:
    print('FAIL: agent-card.json fields do not match BASE_URL (' + base + '):')
    for k, v in bad.items():
        print(f'  {k} = {v!r}')
    sys.exit(1)
print('OK: all agent-card.json URL fields match ' + base)
") || true
echo "$card_ok"
if [[ "$card_ok" != OK:* ]]; then
  exit 1
fi

echo "PASS: $SHA live, db/redis ok, agent-card.json URLs match $BASE_URL"
