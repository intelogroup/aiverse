#!/usr/bin/env bash
# Re-encode every texture inside an interior GLB to WebP. three.js decodes WebP natively, so this is a
# pure download-size win with no runtime cost and no new loader - measured 2026-11-25 on the three
# interiors, with the room re-rendered before and after at three fixed spawns:
#
#   modern-loft-interior   8.58 -> 5.46 MB  (-36 %)
#   market-hall-interior   3.62 -> 3.27 MB  (-10 %)
#   scandi-hawk-interior  14.37 -> 12.38 MB  (-14 %)
#   frame diff: mean |d| 0.06-0.09 / 255, <0.01 % of pixels moved - visually lossless
#
# Run it AFTER the kit builders (kit_loft.py and friends export PNG/JPEG). Idempotent: a file that is
# already smaller or already WebP is left alone.
#
#   tools/city3/optimize_textures.sh                    # every interior GLB
#   QUALITY=90 tools/city3/optimize_textures.sh path/to/x.glb
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BIN="$ROOT/node_modules/.bin/gltf-transform"
Q=${QUALITY:-82}
[ -x "$BIN" ] || { echo "gltf-transform missing: bun add -D @gltf-transform/cli" >&2; exit 1; }

if [ $# -gt 0 ]; then targets=("$@"); else targets=("$ROOT"/apps/console/public/assets/interiors/*.glb); fi
mimes_of() { python3 - "$1" <<'PY'
import json, struct, sys
b = open(sys.argv[1], 'rb').read()
n = struct.unpack('<I', b[12:16])[0]
print(','.join(sorted({i.get('mimeType', '?') for i in json.loads(b[20:20 + n]).get('images', [])})))
PY
}
for glb in "${targets[@]}"; do
  [ -f "$glb" ] || continue
  mimes=$(mimes_of "$glb")
  # Never re-encode an already-WebP file: it costs a generation of quality for a rounding-level gain.
  if [ "$mimes" = "image/webp" ]; then echo "$(basename "$glb"): already webp, skipped"; continue; fi
  tmp="${glb%.glb}.webp.tmp.glb"
  "$BIN" webp "$glb" "$tmp" --quality "$Q" >/dev/null 2>&1 || { echo "$(basename "$glb"): encoder failed, left alone"; rm -f "$tmp"; continue; }
  before=$(wc -c <"$glb"); after=$(wc -c <"$tmp")
  if [ "$after" -lt "$before" ]; then mv "$tmp" "$glb"; else rm -f "$tmp"; fi
  awk -v n="$(basename "$glb")" -v b="$before" -v a="$after" 'BEGIN{printf "%-28s %6.2f -> %6.2f MB%s\n", n, b/1e6, a/1e6, (a<b?"":" (kept original)")}'
done
