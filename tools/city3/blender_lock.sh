#!/usr/bin/env bash
# Run Blender headless, one process at a time (see docs/procedural-city/README.md rule 11).
# Usage: tools/city3/blender_lock.sh -b --python script.py [-- args]
# BLENDER_THREADS overrides the thread cap (default 2); BLENDER_BIN overrides the binary.
set -euo pipefail
LOCK=${BLENDER_LOCK:-/tmp/blender.lock}
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "waiting for the Blender lock ($LOCK)..." >&2
  flock 9
fi
exec "${BLENDER_BIN:-blender}" -t "${BLENDER_THREADS:-2}" "$@"
