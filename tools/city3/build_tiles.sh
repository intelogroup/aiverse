#!/bin/bash
# Split the Bazaar world + collision GLBs into streamable tiles and verify them against the monolith. Run after build_bazaar_pass.sh.
# Output: apps/console/public/assets/tiles/ (content-hashed GLBs + tex/ + col/ + districts.json). The monolith stays the pipeline's source.
set -e; cd "$(dirname "$0")/../.."
A=apps/console/public/assets; T=$A/tiles
TEA="tea:-41,-88,-9,-69"   # interiors/index.json tea rect [-37.5,-84.5,-12.5,-72.5] + 3.5 m: door, lift and structure in one tile
bun tools/city3/split_world.mjs $A/world-city3.glb $T --core-half=9 --hero="$TEA" | grep -vE '^prune|^  t'
bun tools/city3/split_world.mjs $A/world-city3-collision.glb $T/col --layout=$T/tiles.json | grep -E '^textures|Error'
rmdir $T/col/tex 2>/dev/null || true
bun tools/city3/split_shell.mjs $A/world-shell.glb $T
bun tools/city3/verify_tiles.mjs $A/world-city3.glb $T | tail -2
bun tools/city3/verify_tiles.mjs $A/world-city3-collision.glb $T/col | tail -2
bun tools/city3/tiles_manifest.mjs $A
