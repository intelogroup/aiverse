# Instancing Trial — tree / repeated-prop instancing on top of batching

Branch `tmp/instancing-on-batching` (local only — no push/PR/merge in this
lane), based on PR #183's head (`tmp/batching-statics` @ 6c4f4832, itself on
main 05c119e8). Restored from GitHub into `~/workspace/aiverse-instancing/`
after the 2026-11-15 `.build-tmp` wipe destroyed the batching worktree.

## Question

The batching trial proved the merged half of the dev.to city-scene recipe
(draw calls 8,948 → 1,458 at P1, combined merge × cell). This trial proves
the other half — **instancing** — on top of it: trees first (one
`THREE.InstancedMesh` per trunk/branches group per tree kind), then every
other repeated static group with ≥ 25 placements, all behind `?instance=1`
composing with `?batch=both`.

Ship bar (Jim's, same as batching): draw calls AND frame time must BOTH
move (c) vs (b) on this scene, or the verdict is DON'T SHIP.

## States

| State | Tree | URL flags |
|---|---|---|
| (a) pristine main | main @ 05c119e8 | (none) |
| (b) batching only | PR #183 head | `?batch=both` |
| (c) batching + instancing | this branch | `?batch=both&instance=1` |

Default path (no flags) on this branch must read identical to (a) — the
whole mechanism is flag-gated.

## Code

- `src/features/world/bazaarInstance.ts` — the instancing pass
  (`planBazaarInstance` / `apply` via the plan handle). Claims: tree groups
  first (ancestor chain `Tree_packtree*` / `ls_tree`), then groups with
  ≥ `MIN_PLACEMENTS` (25) placements, keyed by (slice geometry, material).
  An item is claimed only if every material slice lands in a claimed group.
- `src/features/world/bazaarBatch.ts` — additive changes only: exports for
  the shared classification (`collectItems`, `IN_SCOPE`, `sliceGroup`,
  `attributeSignature`, `Item`, `Category`) and an optional `exclude`
  predicate on `applyBazaarBatch`. Without `?instance=1` the batch pass is
  called exactly as before.
- `src/features/world/DistrictWorld.tsx` — the hook: with `?instance=1`,
  plan claims → batch with exclusion → apply instancing. Same
  post-`addColliders` point as batching; originals stay in the tree,
  hidden, for the collider system.

## Rig

`measure.mjs` / `film.mjs` are the batching trial's rig, adapted:
playwright-core and the Chromium build repointed (the `.build-tmp`
toolchain was wiped), ports 8913 / 8916, modes `none | both | both-inst |
inst`. Same poses (ORBIT = settled spawn view; P1 = teleport (14, 2.2, 46)),
same settled-plateau rule (two consecutive identical `renderer.info`
reads), same asset (`world-city3-optimized.glb`, sha256 `b14cb2dc…`,
68,501,036 B, served from R2 into `dist/assets/` by the rig).

```
node measure.mjs <run-name> <mode> <path-to-world-city3-optimized.glb>
node film.mjs    <run-name> <mode> <path-to-world-city3-optimized.glb>
```

`census2.py` is the offline (mesh, prim) placement census used to pick the
claim set. Results land in `runs/<name>/meta.json` / `film.json`; the
verdict record is `TRIAL-NOTES.md` in this directory.

## Measurement hygiene

A splat load-test lane renders concurrently on this VM. All settled reads
in `TRIAL-NOTES.md` were taken in windows verified free of the other
lane's Chromium/build processes; the notes record the windows.
