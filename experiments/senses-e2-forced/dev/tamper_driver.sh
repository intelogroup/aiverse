#!/bin/bash
# tamper_driver.sh — detached end-to-end driver for the
# tamper-discrimination test (steps: boot own stack -> scripted
# rehearsal -> 15 paid runs -> teardown). Runs under setsid/nohup so
# it survives exec-session teardown; progress is appended to the log
# named in $1 (default runs/tamper-driver.log).
set -uo pipefail
cd ~/workspace/.build-tmp/agent-senses
LOG="${1:-runs/tamper-driver.log}"
exec >> "$LOG" 2>&1
echo "=== tamper driver start $(date +%H:%M:%S) ==="

dev/dev_up.sh
echo "=== stack up $(date +%H:%M:%S) ==="

python3 dev/tamper_rehearsal.py > runs/tamper-rehearsal.json 2>runs/tamper-rehearsal.err
RC=$?
echo "=== rehearsal rc=$RC $(date +%H:%M:%S) ==="
if [ "$RC" != "0" ]; then
  echo "REHEARSAL FAILED — paid batch NOT started"
  dev/dev_down.sh
  echo "=== driver end (rehearsal failed) $(date +%H:%M:%S) ==="
  exit 1
fi

AIVERSE_GATEWAY_BASE=http://localhost:3100 python3 harness/tamper.py batch --dev-local > runs/tamper-batch.out 2> runs/tamper-batch.err
RC=$?
echo "=== batch rc=$RC $(date +%H:%M:%S) ==="

dev/dev_down.sh
echo "=== driver end $(date +%H:%M:%S) ==="
