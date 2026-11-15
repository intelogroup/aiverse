# Bazaar LOD trial — experiment record (tmp/lod-bazaar)

**Question (Jim, 2026-11-14):** do meshoptimizer LOD levels +
screen-space-error switching on the bazaar's repeated props move draw
calls and fps enough to ship?

**Verdict: DON'T SHIP.** Draw calls did not move (8,956 → 8,956 at the
settled eye-level pose). Triangles fell hard (−34.6% renderer triangles
at eye level, −53.6% at orbit; prop census −72%/−76%) and the city asset
grew +4,743,768 B (+6.9%). fps was not measurable on the trial rig
(SwiftShader renders at a frame every few-to-tens of seconds; the
bottleneck is streaming + shadow + CPU raster, not prop triangles).
Jim's ship bar was draw calls AND fps — neither moved. The lever that
moves draw calls is merging/batching (see the batching trial), not LOD.
Full record: [`TRIAL-NOTES.md`](TRIAL-NOTES.md).

## Contents

- `TRIAL-NOTES.md` — design, prop census, variant-asset construction,
  measurement protocol, results, side findings (incl. the 236 orphan
  nodes in the shipped city GLB).
- `generate-lod.mjs` — builds the variant asset by append-only surgery
  on the PR #163 city GLB: MeshoptSimplifier levels (~50/25/10%) for
  the 154 reachable bazaar prop nodes, LOD0 byte-identical, no
  quantization.
- `rig.mjs`, `measure.mjs`, `diag.mjs`, `diag-lod.mjs` — the
  measurement rig (the console's own renderer at settled poses) and
  diagnostics; `runs/*.log` are the measurement logs.
- `runs/` — A/B evidence: `baseline-p1/film.mp4` and `lod-p1/film.mp4`
  (H.264) with `meta.json` frame/pose records, plus stills.
- `src/features/world/bazaarLod.ts` + the `?lod=1` hook in
  `DistrictWorld.tsx` — console wiring (default path untouched;
  colliders keep pristine LOD0 geometry).

## Re-run it

```bash
# 1. Build the variant asset from the PR #163 city GLB
#    (world-city3.glb, sha256 b14cb2dc…, served from R2 / the console's
#    asset base) — writes world-city3-lod.glb (~73 MB):
node apps/console/lod-trial/generate-lod.mjs

# 2. Serve the console with the variant as the resident asset and
#    compare ?lod=0 vs ?lod=1 at the P1/orbit poses with measure.mjs
#    (see TRIAL-NOTES.md for the settled-pose protocol).
```

`world-city3-lod.glb` is **not** in this PR: at 73 MB it exceeds what
the push path can carry, and it is a generated artifact — step 1 above
regenerates it byte-for-byte from the recorded source asset.
