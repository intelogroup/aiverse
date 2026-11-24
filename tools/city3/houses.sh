#!/bin/bash
# Every placed prebuilt house, re-placeable in one go (place_house.mjs). Sources live outside the repo in $SRC (Sketchfab downloads, credits in
# ASSETS.md); each is first run through slim_textures.py (textures <= 2048 px, JPEG where opaque) into <model>/slim.glb.
# Shared assets (--asset) write one GLB pair per model and yaw; each line adds one house-<id> district at (X, Z).
#   SRC=~/Developer/city3-downloads bash tools/city3/houses.sh        then: rerun the yard passes only on new blocks
set -euo pipefail
cd "$(dirname "$0")/../.."
SRC=${SRC:-$HOME/Developer/city3-downloads}
P() { local model=$1; shift; [ -f "$SRC/$model/slim.glb" ] || python3 tools/city3/slim_textures.py "$SRC/$model/model.glb" "$SRC/$model/slim.glb"; bun tools/city3/place_house.mjs "$SRC/$model/slim.glb" "$@"; }

# plot block (lots 94-100)
P american-house     american-1     -42  108    0 --asset=american --door=none
P stone-cabin        cabin-1        -20   84    0 --asset=cabin --scale=0.02 --body=-7.16,7.16,-3.89,2.4 --floor=0.63 --door=front --doorx=2.8 --doorhalf=1.3 --room="Stone Cabin"
# citadel block (lots 148-155)
P zigurat-villa-pool villa-pool-1  86.5   98    0 --asset=villa-pool --body=-5.2,10.6,-15.9,-1.85 --floor=1.45 --door=none
P mayflower-house    mayflower-1    113   97   90 --asset=mayflower --door=none
# Tea House block (lots 101, 103-106)
P shirakawago-house  shirakawago-1  -45 -107    0 --asset=shirakawago --scale=0.01 --mask --door=none
P zen-tea-house      zen-pavilion-1 -24 -112  270 --asset=zen-pavilion --body=-6,0.74,-3.31,3.76 --floor=1.11 --door=right --doorx=-0.21 --doorhalf=1.55 --ceil=3.9 --room="Zen Tea Pavilion"
