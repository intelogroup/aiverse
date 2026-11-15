# Bazaar LOD trial — notes and verdict (tmp/lod-bazaar, local only)

**Question (Jim, 2026-11-14):** do meshoptimizer LOD levels + screen-space-error
switching on the bazaar's repeated props move draw calls and fps enough to ship?

**Verdict: DON'T SHIP.** Draw calls did not move (Δ 0 at the settled eye-level
pose; −0.2% at orbit). fps could not be shown to move — on this rig it is not
measurable at all (both builds render at a frame every few-to-tens of seconds
under SwiftShader; the bottleneck is interior streaming + shadow + CPU raster,
not prop triangles). The byte cost is +4,743,768 B (+6.9% on the city asset).
The triangle win is real and large (−34.6% renderer triangles at eye level,
−53.6% at orbit; prop-set census −72%/−76%) — but Jim's bar is draw calls AND
fps, and neither moved. If the verse ever needs triangle relief on real GPUs,
this stack is built and verified; the lever that moves draw *calls* is
merging/batching, not LOD.

## The prop set

From the PR #163 city GLB (`world-city3.glb`, 68,501,036 B, sha256 b14cb2dc…),
reachable from the scene root (the file also carries **236 orphan nodes no
loader ever instantiates** — 27 of them dead second copies of prop nodes;
worth a separate cleanup, out of scope here):

- **154 nodes**: 80 stalls (all sharing ONE mesh, `LIB_sk_med_stall`, 600 tris),
  70 `inst_goods_*` nodes, 4 `FountainClayPot*` nodes.
- **72 distinct meshes, 1,006 instances, LOD0 rendered triangles 1,572,988.**
- Worst meshes: bowls 14,000 tris ×22 = 308,000; goblets 7,648 ×27 = 206,496;
  ewers 8,397 ×24 = 201,528; woven baskets 1,024 ×135 = 138,240;
  terra pots 3,928 ×15 = 58,920; stalls 600 ×80 = 48,000.
- Characters, skinned meshes and hero pieces were excluded by construction
  (name-pattern targeting only); LOD0 is the untouched original geometry.

## The variant asset (append-only surgery, PR #163 precedent)

`generate-lod.mjs` decodes the GLB with three's GLTFLoader (MeshoptDecoder),
simplifies each distinct target mesh with MeshoptSimplifier
(`simplifyWithAttributes`, normals w=1, uv w=0.25, `ErrorAbsolute`) at
~50% / ~25% / ~10% triangle budgets per primitive, and appends the results to
the BIN chunk as plain bufferViews. Each target node gains `__lvl1/2/3` child
nodes (same mesh-sharing as the originals; instanced nodes reference the SAME
instance accessors — zero instance-data duplication), each carrying
`extras.lod = {level, error, tris, srcTris}`. **No quantization** — float32
attributes copied from the decoded source.

Verified: every original accessor/bufferView/mesh is a byte-identical prefix
of the variant; original nodes differ only by added children; the BIN prefix
is byte-identical; `buffers[1]` (meshopt fallback declaration) untouched.

- Variant: **73,244,804 B** (+4,743,768 B = **+6.93%**); appended geometry
  4,449,900 B; 452 `__lvl` nodes; 216 new meshes.
- Error semantics calibrated on bolts_c LOD1: simplifier-reported 0.0896 m vs
  brute-force vertex-distance proxy 0.065 m — same order, simplifier is the
  conservative number. LOD1 errors: median 0.125 m across meshes; the big
  offenders are tiny (bowls 0.002 m, goblets 0.001 m, ewers 0.003 m).
- Whole-set ceilings if everything sat at one level: LOD1 819,910 tris,
  LOD2 449,179, LOD3 257,120 (vs LOD0 1,572,988).

## Console wiring (`?lod=1` only; default path untouched)

`src/features/world/bazaarLod.ts`, hooked in DistrictWorld's resident effect
**after** `addColliders` (camera collision keeps the pristine LOD0 meshes —
the level objects are the same objects, re-parented). Each prop node is
wrapped in a `ScreenSpaceLod extends THREE.LOD`:

- Switch distance per level: `error_k × worldScale × maxInstanceScale ×
  projFactor / 1px`, `projFactor = drawingBufferHeightPx / (2·tan(fov/2))`
  (fov 45; = 435 at the rig's 640×360). **Error target: 1 px.**
- Selection replicates three r170 `LOD.update`, except the measured distance
  is the **effective distance to the nearest instance** (per-instance centres
  through the instance matrices, minus that instance's radius). First build
  used the set bounding sphere instead: for bazaar-wide instance sets the
  sphere's surface sits metres from every real instance, which pinned those
  sets at LOD0 (census −0.65% only). The census caught it; the per-instance
  metric is the shipped-in-trial version and all numbers below are its.
- A final empty level culls a prop once its nearest instance's full extent
  projects under 1 px (engaged once, at orbit).
- `window.__bazaarLod` exposes `{count, histogram(), census()}` (registered
  in the sensorium allowlist — see gate delta).

## Rig and measurement protocol (read this before quoting the fps line)

The console's own renderer path throughout: the branch build served locally,
headless Chromium + SwiftShader, `/?tiles=0&streamDebug=1`, camera driven by
the console's own `__city3Stream.teleport`. The planned fixed camera path
(segment A (14,2.2,46)→(14,2.2,−46) 16 s, B →(−30,2.2,−46) 8 s, C →(−30,2.2,30)
13 s at 5.75 m/s) proved unmeasurable on this VM: frames take 5–40 s
(interior-streaming builds dominate the main thread), so a moving capture is
a handful of frames at uncontrolled positions. **Deviation:** the path's
start pose **P1 (14, 2.2, 46)**, view toward −z, was held until the
renderer counters plateaued (identical consecutive reads), identically for
both builds; the spawn orbit view is reported as a second pose. Viewport
640×360 (stepped down from 960×540 per the trial plan's ladder; same both
runs). Settled reads reproduced across independent runs within 0.25%.

## Results (settled plateau reads)

| Metric | Baseline | LOD | Δ | Δ% |
|---|---|---|---|---|
| Draw calls @ P1 | 8,956 | 8,956 | 0 | 0.0% |
| Triangles @ P1 | 6,006,394 | 3,929,296 | −2,077,098 | **−34.6%** |
| Prop census @ P1 | 1,572,988 | 441,493 | −1,131,495 | **−71.9%** |
| Draw calls @ orbit | 1,694 | 1,690 | −4 | −0.2% |
| Triangles @ orbit | 4,117,660 | 1,909,266 | −2,208,394 | **−53.6%** |
| Prop census @ orbit | 1,572,988 | 371,225 | −1,201,763 | **−76.4%** |
| City asset bytes | 68,501,036 | 73,244,804 | +4,743,768 | +6.93% |
| All GLB bytes served | 102,943,852 | 107,687,620 | +4,743,768 | +4.6% |
| Captured fps | 0.03 | 0.05 | — | not decision-grade |

Level histogram @ P1: {lod0: 96, lod1: 28, lod2: 13, lod3: 17, culled: 0} of
154. @ orbit: {lod0: 95, lod1: 23, lod2: 17, lod3: 18, culled: 1}.
Renderer-triangle savings exceed the census savings because props draw
twice (shadow pass + main pass). Draw calls are flat *by construction*:
exactly one level renders per prop; only the cull level can remove a call,
and at these distances it essentially never engages.

**fps honesty:** the films (below) contain 7 and 10 frames across ~3–4 minute
captures — 0.03–0.05 fps. That is the rig (SwiftShader on 1.5 shared vCPUs,
interior streaming, soft shadows), not the builds: the baseline is equally
slow, so no fps delta is claimable either way, and the ≥10 fps filming bar is
unreachable on this hardware for the unmodified console too. Any real fps
question needs a GPU machine.

## Gates

- Baseline (unmodified 4ca120d5): 92 files passed / 1 skipped; 841 tests
  passed / 1 skipped; 0 failed.
- Branch (final): **93 files passed; 842 tests passed; 0 failed, 0 skipped.**
  Totals identical (93 files / 842 tests). Two explained deltas: (1) the
  sensorium allowlist test failed until `__bazaarLod` was registered in
  `KNOWN_GLOBALS` with its justification (the guard working as designed);
  (2) the one baseline skip runs and passes on the branch — it appears to be
  gated on build artifacts (tiles) that only exist after a build; flagged as
  inference, and a skip→pass flip hides no failure.

## Films

- `runs/baseline-p1/film.mp4` — H.264, 640×360, ffprobe: 7 frames
  (6 screencast captures + 1 concat-terminator repeat), 231.6 s span.
- `runs/lod-p1/film.mp4` — H.264, 640×360, ffprobe: 10 frames (9 + 1),
  171.2 s span.
- Stills: `runs/baseline-still.png`, `runs/lod-still.png` — the LOD still
  shows the bazaar from orbit with stalls/props intact, no doubling or
  z-fighting.

## Files

- `generate-lod.mjs` — variant generator (three + meshoptimizer from the
  world-compress toolchain; no new stack).
- `world-city3-lod.glb` — the variant asset.
- `measure.mjs` / `diag.mjs` / `diag-lod.mjs` — the measurement protocol that
  produced the settled reads (diag = no-screencast reader; measure = film
  capture). `rig.mjs` — the earlier moving-path rig, kept for the record.
- Console: `src/features/world/bazaarLod.ts` (new), DistrictWorld hook,
  sensorium allowlist entry.

Local only: no push, no PR, no merge, no deploy, no production change.
