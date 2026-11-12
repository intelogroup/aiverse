#!/bin/bash
# Rebuild the Bazaar exterior + demolition + interiors + open space from the last committed world GLBs, then rebake the navmesh and verify.
set -e; cd "$(dirname "$0")/../.."
git checkout apps/console/public/assets/world-city3.glb apps/console/public/assets/world-city3-collision.glb apps/console/public/assets/interiors apps/console/public/assets/city3-anchors.json
python3 tools/city3/bridge_bazaar_demolish.py
python3 tools/city3/bridge_bazaar_interiors.py
python3 tools/city3/bridge_bazaar_open_space.py
python3 tools/city3/verify_bazaar_interiors.py
bun run packages/world-sim/node/bakeNavmesh.ts | tail -1
