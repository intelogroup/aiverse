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

Measured 2026-11-16 (UTC), same session, settled reads only.
Measurement windows were serialized against the splat load-test lane
on the same VM: every pass started only after verifying no splat-lane
Chromium/node process was active (chain v2's cwd-based check, then
manual /proc checks). One interference slipped through — see
deviation 2.

Two rigs produced the numbers. `measure.mjs` (the batching rig,
no screencast) settled the ORBIT pose reliably for every state, but
its P1 settle plateaued on the stale pre-teleport frame in both batch
states (the app renders on demand; a static pose emits no frames —
frameDeltas 0 post-teleport in both passes). P1 therefore comes from
`probe-p1.mjs`: same poses, same snapshot expression, same
two-identical-reads plateau rule, plus a CDP screencast started
before load (the film pass's trick) so post-teleport frames land.
The probe validates itself against history: its (b) P1 —
1,458 calls / 7,039,214 tris — reproduces the batching trial's
reported combined-mode P1 **exactly**, and its orbits reproduce the
measure passes' plateaus exactly in both batch states.

| State | Orbit calls | Orbit tris | P1 calls | P1 tris | Orbit frame median |
|---|---|---|---|---|---|
| (a) main 05c119e8, no flags | 18,274 | 7,779,994 | not measurable¹ | — | — |
| (b) batch=both (PR #183 tree) | 1,797 | 7,779,994 | 1,458 | 7,039,214 | 1,183 ms (rAF, n=6) |
| (c) batch=both&instance=1 | **1,500** | 7,779,994 | **1,296** | 7,468,552 | **800 ms** (rAF, n=9) |
| (c) code, no flags (default-path proof) | 18,274 | 7,779,994 | — | — | — |

¹ State (a) at ~18k calls starved every post-teleport evaluate in
both rigs (teleport race-timeout; P1 settle: 0 reads, 8 warm
timeouts). Its orbit is the converged value: two reads agreed at
18,274 / 7,779,994 (the settle's plateau flag is false only because
the agreeing reads were not consecutive — spawn-view actors make
exact consecutive repeats rare at full scene weight). The (c)-code
no-flags pass then plateaued **consecutively** at the identical
18,274 / 7,779,994, which is the default-path proof: no flags → the
(c) build reads exactly as pristine main.

**The instancing delta, (c) vs (b):**

- Draw calls: orbit 1,797 → 1,500 (**−297, −16.5%**); P1 1,458 →
  1,296 (**−162, −11.1%**). Both poses move.
- Frame time (orbit, in-page rAF medians, the trial lineage's own
  instrument): 1,183 → 800 ms (**−32%**). Sample counts are small
  (n=6 / n=9) and absolute SwiftShader numbers are
  environment-dominated — the batching trial read ~317 ms for the
  same (b) code on the old main — so the within-session ratio is
  the signal, not the absolutes. A real-GPU frame-time check is
  still owed (see Verdict).
- Triangles: orbit unchanged (7,779,994 both — the whole city is in
  frame at spawn, so nothing new is culled or drawn). P1 **+429,338
  (+6.1%)**: instanced groups carry whole-group bounding spheres
  (a tree group spans up to 16 of the 128 m cells), so at a local
  pose the renderer draws a group's out-of-view instances that
  batching's per-cell buckets would cull. This is a real culling
  tax, stated plainly — but it is not the merge arm's +30%: it is
  pose-dependent, zero at the wide pose, and buys the call
  reduction above. Per-cell instancing was rejected by design (it
  yields the same mesh count as batching's buckets and cannot move
  calls); the tax is the price of the global-per-group shape the
  dev.to article describes.

**What got instanced** (live census from the (c) run,
`runs/c-both-inst/meta.json`): 30 InstancedMesh groups, 4,716 items
claimed, 5,056 placements, 959,449 tris instanced. Trees: 6 groups —
LIB_hero_tall ×189, LIB_hero_full ×141, LIB_hero_birch ×78 (408
trees, trunk+branches groups each). Landscape: bushes ×409/×399,
flowers 3 kinds ×2 prims ×285–291, rocks ×247 ×2 prims, path stones
×156 ×3 prims. Props: lanterns ×150, baskets ×135, crates ×114,
stalls ×80, benches ×57, goods lanterns ×51, grainsacks ×45, sacks
×33, buckets ×28, rollpiles ×28, goblets ×27. Knock-on batching
effect of the exclusions: buckets 749 → 569, baked geometry
202.9 MB → 126.7 MB, bake 10,611 → 7,017 ms. Instancing itself:
build 11 ms, group geometry stored once = 719,122 B (≈76.3 MB
saved vs baking those placements), 266 cell-buckets avoided.
Colliders/navmesh: originals are hidden in-tree, never removed or
mutated — and deviation 4 below accidentally proved they all
persist.

## Films

Inherited-protocol films (screencast from before load; load-in +
spawn hold + teleport flight + 240 s P1 hold; H.264, yuv420p,
faststart, 640×360):

- (b) `runs/b-both/film.mp4` — 465 frames captured, 407 in the MP4,
  227.5 s, captured rate 1.43 fps.
- (c) `runs/c-both-inst/film.mp4` — 333 frames captured, 287 in the
  MP4, 258.9 s, captured rate 1.08 fps.

**The ≥10 fps bar is not met — by any state, in this environment.**
The app emits frames only on state change: static holds produce
zero frames for minutes (a 100 s gap sits in the (b) film's
intervals), and a full-scene SwiftShader render takes ~0.8–1.2 s,
so no capture protocol on this VM reaches 10 fps of real frames.
Frames were never duplicated or padded to inflate the count. The
films stand as honest before/after captures; the fps requirement
and a true orbit film are owed on a real GPU (see Verdict). Active
-phase frame intervals (load-in/streaming, the only continuously
rendering phase) were equal or smaller for (c): first-third median
18.5 ms vs (b)'s 68.5 ms, mid-third 13 vs 14 ms — consistent with
the rAF frame-time direction, though film pacing is not a
controlled instrument and is not load-bearing for the verdict.

## Gates

Console suite (vitest, 96 files / 859 tests), tsc -b, vite build:

- (b) baseline in-session: 857 passed / 1 skipped / 1 failed — the
  failure is `bodyController.test.ts`'s wall-clock cost assertion,
  failed under CPU contention from the splat lane. tsc + vite clean.
- (c) in a contended window: identical totals (857/1/1); the failure
  was this trial's own `sensorium.test.ts` allowlist omission for
  `__bazaarInstance` — fixed in 6efdd0c (mirrors the existing
  `__bazaarBatch` entry), standalone rerun 6/6.
- (c) quiet-window rerun after the fix: **858 passed / 1 skipped /
  0 failed** (`runs/gates-c-vitest-quiet.log`). tsc -b + vite build
  clean for (a), (b) and (c).

(c) is no worse than the (b) baseline on every gate; in a quiet
window it is fully green.

## Verdict

**SHIP** — as the flag-gated trial build it is (`?instance=1`
composing with `?batch=both`; default path proven identical to
main above). Against Jim's bar, (c) vs (b) on his scene:

- Draw calls move at both poses: −16.5% orbit, −11.1% P1.
- Frame time moves on the trial's own instrument: −32% orbit rAF
  median (SwiftShader; small n).
- Triangles: flat at orbit; +6.1% at P1, disclosed — the
  whole-group-bounds culling tax, not merge's +30%.

Owed before this could become an always-on default: (1) a
real-GPU frame-time + orbit-film check (SwiftShader fps is not a
GPU number; the ≥10 fps film bar is untestable here); (2) a
product call on the P1 triangle tax — if it matters, the follow-up
shape is per-region instanced groups (a handful of cells per
group), which would trade some of the call win back for culling.

## Deviations and incidents

1. First (b) launch died on EADDRINUSE: the splat lane's leftover
   server held port 8913. Rig ports moved (measure 8923, film
   8926); no reads were taken on the dead attempt.
2. The splat lane's orphaned Chromium (parent node gone, started
   04:22:59 UTC) saturated the VM through (b)'s P1/liveness phase
   and invalidated that pass's P1. After confirming the parent was
   dead, the orphan was killed (04:34 UTC). All later passes ran
   with the lane idle, verified per pass.
3. `measure.mjs`'s P1 settle plateaued on stale pre-teleport
   frames in both batch states — resolved with `probe-p1.mjs`
   (screencast-forced frames), validated by exact reproduction of
   the batching trial's (b) P1. The probe's drag-orbit phase crawled
   against the post-showAll doubled scene in the (c) run (~9 min of
   starved mouse ops) and answered negatively: 8 screencast frames
   in 30 s of dragging, 0 rAF deltas — mouse drag does not drive
   this view's camera/renderer, so no orbit-drag film is possible
   with it. The drag test was skipped for the later probes.
4. `__bazaarBatch.showAll()` is a blunt all-items reset
   (bazaarBatch.ts:409): in probe (c) it un-hid batching's and
   instancing's originals and a landed frame read 6,171 calls /
   11,029,932 tris (double visibility). That read was rejected as
   P1 (the direct settle is reported); the accident positively
   confirms every hidden original remains in the scene tree.
   The hideDoors round-trip itself moved no counters at P1 in
   either probe — door share at P1 is not measurable with this
   rig, and no claim is made from it.
5. The VM rebooted at ~05:04 and ~07:05 UTC, killing the
   measurement chain mid-(c)-default and the first (c)-default
   rerun. Passes were relaunched individually; the chain's c-film
   and a-measure were replaced by standalone runs of the same rigs.
6. Probe (a) with screencast produced zero settled reads (encoder
   starvation at ~18k calls) — state (a) was measured without
   screencast instead, per deviation in Results note 1.
7. Both in-session vitest failures are accounted for under Gates;
   neither is a code regression in (c).
