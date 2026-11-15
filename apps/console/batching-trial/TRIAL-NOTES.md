# Batching Trial — Notes

Branch `tmp/batching-statics` (local only, no push/PR/merge/deploy), based on
main `0636bcc` (Merge PR #180, owner follow-cam). Plan:
`BATCHING-PLAN.md` in the LOD trial directory
(`~/workspace/.build-tmp/aiverse-lod/apps/console/lod-trial/`).
Rig: the LOD trial's web-render protocol transplanted to current main —
same server pattern, same headless SwiftShader Chromium (640×360), same
poses (ORBIT = settled spawn view; P1 = teleport (14, 2.2, 46)), same
settled-plateau rule (two consecutive identical renderer.info reads),
same asset (`world-city3-optimized.glb`, sha256 `b14cb2dc…`, 68,501,036 B).
All runs used `?tiles=0&streamDebug=1` plus `&batch=<mode>`.

## Verdict (against Jim's ship bar: draw calls AND fps must move)

**SHIP the combined mechanism (merge per material × 128 m cell) —
draw calls and frame time both move decisively on our scene.**
P1 draw calls 8,948 → 1,458 (−83.7%); orbit 18,274 → 1,797 (−90.2%).
Frame time at the settled spawn view: rAF median ~9,689 ms (baseline)
→ ~317 ms (combined), ~30× faster under SwiftShader; at static P1 the
baseline renderer produced essentially no frames while the combined
build keeps producing them (35 frames in the 240 s film hold).
Merge-only is even cheaper on calls (1,100 at both poses) but pays
+30% rendered triangles at P1 (see tension below); the cell split
buys most of that back (7,039,214 tris) for +358 calls vs merge-only.
Cells alone do NOT ship: they don't reduce calls at all (+2–4%).

## Census — the ceiling

Offline GLB census (`census.py`, world-city3-optimized.glb): 4,780
nodes, 4,544 reachable, **236 orphan nodes** (never baked; 27 of them
prop-pattern — matches the LOD trial's orphan finding). Reachable:
4,447 mesh nodes / 9,056 prims / 3,916,042 tris (single-pass count).
In-scope (propFamily + otherStatic): 4,388 nodes, 8,986 prims,
5,295 node-instances, 3,872,310 tris = **99.2% of resident prims**.
Doors (excluded): 58 nodes / 69 prims / 43,666 tris. Water/sea: 1 node.

In-page census (live three scene, `bazaarBatch.ts` census mode)
cross-checks almost exactly: 9,056 items; propFamily 172 items /
1,572,988 tris (identical to offline); in-scope 8,986 items /
3,872,224 tris (86-tri delta vs offline, one mesh's index reading);
**399 distinct materials** among in-scope items (the merge-bucket
count driver); 0 multi-material items (GLTFLoader splits multi-prim
meshes into single-material items); 104 instanced in-scope items.

Hide-diff at P1 (census run, plateau-verified): baseline P1
8,948 calls / 5,972,986 tris → hide all in-scope statics →
**171 calls / 152,871 tris**. In-scope statics are **8,777 of 8,948
P1 draw calls (98.1%)** and 97.4% of P1 triangles. The theoretical
floor at P1 is ~171 calls + however many merged meshes a scheme
needs; the combined build lands at 1,458.

## Delta table (settled plateaus; frame time = in-page rAF medians)

| Variant | P1 calls | P1 tris | Orbit calls | Orbit tris | Geometries | Orbit frame | P1 frame |
|---|---|---|---|---|---|---|---|
| baseline | 8,948 | 5,972,986 * | 18,274 | 7,779,994 | 4,306 | 9,689 ms (n=8) | ~no frames (n=0; census run 1,883 ms, n=14) |
| (a) merge | 1,100 (−87.7%) | 7,779,994 | 1,100 (−94.0%) | 7,779,994 (0%) | 546 | 300–367 ms (n=14/12) | frames flow (film hold: 30 fr / 240 s) |
| (b) cells | 9,136–9,337 (+2–4%) | 5,030,014 early / 7,899,078 late * | 18,663 (+2.1%) | 7,779,994 | 4,307 | ~baseline (n=1 usable) | ~baseline |
| (a)+(b) both | 1,458 (−83.7%) | 7,039,214 | 1,797 (−90.2%) | 7,779,994 (0%) | ~750+ | 317 ms (n=14) | 717 ms (n=12) |

\* P1 triangles carry a **streaming-tail confound**: P1 rendered tris
grow as late content streams in (≈5.0–6.0M in early settled reads,
≈7.8–7.9M converged; the cells run read both states). Comparisons
that hold at matched states: at orbit (converged in every run) tris
are identical in all variants — merging neither creates nor destroys
triangles there. At P1, merge-only renders the full 7,779,994
(bucket bounding spheres span the city → nothing culled), i.e. it
restores the ~1.8M tris per-object culling used to drop; the cell
split re-culls out-of-cell buckets and lands at 7,039,214 (−9.5% vs
merge-only, ≈−10% vs the converged baseline band). **Draw calls are
the robust metric; they stabilize early and are unaffected.**

Served GLB bytes are **identical in all variants (102,943,852 B
total; city GLB 68,501,036 B)** — the transformation is runtime /
in-memory, nothing about the shipped asset changes. The real byte
cost is resident memory: merged attribute+index data is
**214,455,300 B (merge) / 202,920,966 B (both)** for 5,071,768 baked
verts, baked in **7.3 s / 6.3 s** at district load (cells split:
86 ms). Originals stay in the scene (hidden) so colliders and the
pristine graph are untouched — memory holds both copies.

## Mechanisms

Tooling: `@zkmake/three-batch` v0.1.3 was evaluated first and
**rejected** — its `bake()` refuses instanced and multi-material
meshes (the majority here) and `chunkInstances` disposes source
instance buffers the collider system still holds. Hand-rolled with
three's own `BufferGeometryUtils.mergeGeometries`, following the
repo's `bazaarLod.ts` pattern (`bazaarBatch.ts`, `?batch=`-gated in
DistrictWorld; originals hidden, never removed or mutated).

- (a) merge: every in-scope instance world-baked into one geometry
  per (material, attribute-signature) bucket: **399 buckets,
  10,183 pieces, 0 fallbacks**. Category safety: classification
  tests the item's FULL ancestor name chain (GLTFLoader nests
  multi-prim meshes under a Group; a leaf's own name can miss the
  semantic node name — tea-house door panels would otherwise have
  been baked shut). Doors/stateful/water/hidden excluded throughout.
- (b) cells: single-material InstancedMesh items re-instanced per
  128 m cell with per-cell bounding spheres: 104 items → **300 cell
  meshes**. Alone it cannot move calls (98% of in-scope items are
  regular meshes); at orbit it slightly ADDS calls (all cells
  visible); at P1 it culls triangles (−15.8% at matched early
  state) without touching call count.
- (a)+(b): merge buckets keyed per (material, cell): **749 buckets**.

## Films (H.264, 640×360, real captured frames)

- baseline: `runs/baseline/film.mp4` — 278 frames captured
  (279 in MP4), load-in + spawn view. SALVAGE: the film pass was
  killed by a VM restart at 361 s; the teleport evaluate timed out
  in that pass, so there is no P1 segment, and per-frame timestamps
  (in-memory) were lost — the MP4 is encoded at the measured average
  pacing (1.26 s/frame over ~350 s). See `runs/baseline/film.json`.
- merge: `runs/merge/film.mp4` — 214 captured (206 in MP4),
  267 s, incl. 30 frames during the static P1 hold.
- both: `runs/both/film.mp4` — 272 captured (249 in MP4), 264 s,
  incl. 35 P1-hold frames. Final frame visually verified: ground
  level inside the bazaar — stalls, striped canopies, buildings —
  merged geometry rendering correctly.
- cells: no film (cells alone is not a ship candidate; its counters
  are the record).

Filming on current main is nothing like the LOD era — see below.

## What current main changed under the rig (methodology record)

- **Settled spawn is ~10× heavier than the LOD era**: 18,274 calls /
  7,779,994 tris plateau (reproduced identically across 5+ loads),
  vs the LOD trial's single early presenting read of 1,694 calls.
  The LOD orbit figure was one pre-settle snapshot; P1 is the
  comparable pose and it reproduces across mains (8,948 here vs
  8,956 in the LOD trial, −0.1%).
- **The renderer emits no frames at a static pose** (demand-style
  loop): screencast 0 frames in 210 s at static P1; CDP
  captureScreenshot ×3 all 120 s timeouts; rAF sampler 0 deltas in
  minutes. Frames flow while state changes (load-in, streaming,
  teleport). Consequences: films must start the screencast BEFORE
  load and ride state changes (film.mjs v2); a sway-cam variant
  (teleport nudges) did NOT wake the loop (0 frames, 0 rAF deltas).
- **renderer.info counters describe the last rendered frame** —
  two identical reads can be one stale frame. Caught live in the
  cells re-run (P1 settle "plateaued" on the orbit frame). Defenses
  used: 30 s post-teleport wait (added after that catch), a
  hide/show liveness round-trip whose restored settle is the
  reported P1 for batch modes, and diag4's dispose() test (P1
  counters moved between reads while streaming; dispose crashed
  geometry memory 578 → 179 — proving the P1 state was live).
  Visibility toggles alone do NOT force a re-render (the doors
  toggle never moved counters in any mode) — noted so the next
  trial doesn't re-derive it.
- **VM restarts killed three runs** (baseline measure #1, baseline
  film pass, cells measure #1) at the runtime's ~1–2 h cadence;
  every number reported here is from a completed run or, where
  marked (baseline film), an explicitly labeled salvage.
- Frame-time honesty: absolute fps is unmeasurable under
  SwiftShader (~0.03–0.1 fps baseline). Reported frame times are
  in-page rAF medians at settled poses + film frame production —
  comparable across variants, not product fps. A GPU machine is
  still required for a true fps number; what this VM CAN say is
  that per-frame cost fell ~30× at spawn and frames went from
  ~never to continuous at P1.

## Gates

- Console vitest (`bun run test`): branch **95 files / 858 tests
  passed, 1 skipped, 0 failed** — identical to the pristine-main
  baseline gate on 0636bcc. `tsc -b && vite build` clean
  (VITE_ASSET_BASE="").
- The batch module is fully `?batch=`-gated: default page behavior
  is byte-identical to main (baseline runs above are the branch's
  own build with no query flag).

## Risks if shipped for real

1. **+~200 MB resident geometry memory** and originals retained
   (colliders) — on low-end devices this needs a budget decision;
   a production version should drop originals' GPU buffers after
   bake where colliders allow.
2. **~6–7 s bake** at district load (one-off, worker-able).
3. Merge-only raises P1 rendered tris +30% vs the early-state
   baseline read — ship the **combined** form, not merge-only.
4. Night theming re-tints shared materials — merged meshes share
   the same material objects, so theming still applies (verified
   in code path; not visually compared day-vs-night in this trial).
5. Anything that later needs per-object state in scope (a stall
   that becomes interactable) must be excluded by name, like the
   radio/doors are now.

## Run artifacts

`runs/{baseline,census,merge,cells,both}/meta.json` (+ `film.json`
for baseline/merge/both), run logs `runs-*.log`, diag scripts
`diag.mjs`–`diag4.mjs` kept for the methodology trail. Trial code:
`src/features/world/bazaarBatch.ts`, DistrictWorld `?batch=` hook,
`batching-trial/{census.py,measure.mjs,film.mjs}`.
