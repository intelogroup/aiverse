# Instancing Trial — Notes

Branch `tmp/instancing-on-batching` (local only, no push/PR/merge/deploy),
based on PR #183's head `tmp/batching-statics` @ 6c4f4832 (main 05c119e8).
Restored from GitHub into `~/workspace/aiverse-instancing/` — the batching
trial's local worktree was cleaned up and then `~/workspace/.build-tmp`
was wiped (2026-11-15), so PR #183 is the surviving record of state (b).
Plan/record: this file + `README.md`. Rig: the batching trial's protocol
(same server pattern, headless SwiftShader Chromium 640×360, ORBIT =
settled spawn view, P1 = teleport (14, 2.2, 46), settled-plateau rule =
two consecutive identical renderer.info reads, frame time = in-page rAF
medians), asset `world-city3-optimized.glb` sha256 `b14cb2dc…`,
68,501,036 B. All runs `?tiles=0&streamDebug=1` plus the state flags.

States: (a) pristine main 05c119e8, no flags. (b) PR #183 tree,
`?batch=both`. (c) this branch, `?batch=both&instance=1`. Default-path
proof: this branch with no flags must read as (a).

## Census — what there is to instance (offline, census2.py)

4,159 in-scope (mesh, prim) groups; 10,183 placements total. The
repeated head of the distribution:

**Trees (the brief's first target)** — three kinds, trunk + branches
prims each, all `otherStatic`:

| Kind (mesh) | Trunk prim | Branches prim | Tris/tree | Placements |
|---|---|---|---|---|
| LIB_hero_tall (Tree_packtree_b, ls_tree) | 264 (Tree_Trunk_01) | 366 (Tree_Branches_01.001) | **630** | 189 |
| LIB_hero_full (Tree_packtree_a, ls_tree) | 338 (Tree_Trunk_01) | 286 (Tree_Branches_01.001) | **624** | 141 |
| LIB_hero_birch (Tree_packtree_c, ls_tree) | 129 (Tree_Trunk_02) | 156 (Tree_Branches_02) | **285** | 78 |

408 trees, ~232k tris in total (~3% of the converged scene). Per-tree
cost is 285–630 tris — NOT heavy per tree (this is a low-poly stylized
set, not the dense scans the 4-vertex trick targets). The
BlenderVitals-style 4-vertex tree rebuild is therefore recorded as a
possible separate lane but with a bounded ceiling: even deleting every
tree triangle outright could only remove ~3% of rendered tris; the
instancing question here is draw calls and frame time, not tree tris.
No Blender work in this trial (per brief).

**Other repeated statics ≥ 25 placements** (claim threshold
MIN_PLACEMENTS = 25): landscape set — bushDetailed 409, bush 399,
flowers 3 kinds × (grass+color prims) 285–291 nodes each, rocks 247 × 2
prims, path stones 156 × 3 prims; props — lanterns 150 × 338 tris,
crates 114 × 600, stalls 80 × 600, benches 57 × 600, baskets 135
placements (one GPU-instanced node) × 1,024, goblets 27 × 7,648,
grainsacks 45, sacks 33, buckets 28, rollpiles 28. Below threshold and
left to batching: ewers (24 × 3 groups), pots, bowls, and everything
smaller.

Claim rule as built: trees always; other groups at ≥ 25 placements;
an item is claimed only when ALL its material slices are claimed (no
prim can fall between batching and instancing).

## Results

_MEASUREMENTS PENDING — filled in from runs/*/meta.json. Measurement
windows are serialized against the splat load-test lane (same VM):
every pass below was started only after verifying no splat-lane
Chromium/build process was active._

| State | P1 calls | P1 tris | Orbit calls | Orbit tris | Orbit frame | P1 frame |
|---|---|---|---|---|---|---|
| (a) main, no flags | | | | | | |
| (b) batch=both | | | | | | |
| (c) batch=both&instance=1 | | | | | | |
| (c) code, no flags (default-path proof) | | | | | | |

## Films

_FILMS PENDING._

## Gates

_GATES PENDING._

## Verdict

_VERDICT PENDING._
