# World tiles (phone-load plan, option B)
Status 2026-11-13: built and gated, behind `?tiles=1`, off by default. The 2 s cold-start target is NOT met (see Numbers).

## What it is
`world-city3.glb` (91 MB, 35 MB brotli) is cut into tiles that stream by distance, so a phone downloads a small core on the fountain first.
- Build: `tools/city3/build_tiles.sh` (after `build_bazaar_pass.sh`). Steps: `split_world.mjs` (visual, then collision with `--layout` so squares match), `split_shell.mjs`, `verify_tiles.mjs` (the gate, both sets), `tiles_manifest.mjs`.
- Output (generated, NOT committed, ~85 MB): `apps/console/public/assets/tiles/` = content-hashed tile GLBs, `tex/` (textures written once), `col/` (collision tiles), `shell.<hash>.glb`, `districts.json` (tile manifest), stable aliases `core.glb` / `core.col.glb`.
- Grid: 3x3-nested squares around (0,0) over a 486 m root, 18 m cells, so the centre cell of every level contains the spawn. The core is an 18 m square (`--core-half=9`: 78k tris, 0.31 MB geometry + 0.69 MB textures; half 27 carries 5 MB). The Tea House (`--hero=tea:...`) is its own tile because TeaDoorLeaf/TeaElevator edit its door instance and four lift placeholders in one scene.
- Runtime: `?tiles=1` -> `tilesMode.ts` (preloads the critical path), `DistrictWorld` streams tiles like districts (`origin`, manifest `streaming`), `tileScenes.ts` lets the Tea components wait for their tile, `WalkColliders.covered` stops bodies at the edge of loaded collision.

## Traps found
- Embedding textures per tile tripled the total (144 of 218 MB): textures live outside, hashed, referenced by relative uri.
- Wide triangles (ground, water quads) assigned by centroid leave holes where their far tile is not loaded: > 40 m triangles ride in the core.
- The monolith keeps unreferenced vertices from demolished lots; tiles drop them (bbox checks must use referenced vertices only, see verify_tiles).
- three renames sub-meshes by primitive index, so compare by material name, not node name.
- Collision tiles can exist where no visual tile does (open plaza): manifest entry with empty `url`.
- `shell_bazaar` carpets loaded detail with massing unless it is split per tile (same bug as the 2026-11-09 resident-shell note).
- Spawn needs collision around the fountain (r 10 solid): `findSpawn` on the 18 m core alone put the body at the basin rim.
- The R2 custom domain allows CORS only from `http://localhost:5183`; serve acceptance builds on that port.
- Characters, not tiles, were the first main-thread stall (GLTFLoader loadAccessor/loadAnimation) and shader program creation the second (`checkShaderErrors` forces a synchronous link check).

## Numbers (emulated phone: 390x844 @3x, Fast 4G, cold context; real GPU, Apple M4)
| | monolith | tiles |
|---|---|---|
| transferred to a walkable spawn | 35 MB world + app | 2.3 MB |
| walkable | ~52 s (4x CPU) | 6.5 s first run (4x CPU); 9.5-14 s in later runs (1x and 4x, high variance) |
Main-thread profile of the tiles cold start (JS Self-Profiling, 1x CPU): program creation/link (three `C`, `n`) 6-7 s, GLTF parse of the characters ~1 s, render frames the rest. The wire is no longer the limit; first-render CPU/GPU work is.

## Open
- 2 s needs far fewer distinct shader programs (676 materials in the world, ~100 per tile) and/or compileAsync per tile, a lighter first scene, and deferred characters.
- Each tile decodes its own copy of shared textures (GPU memory), and collision BVH builds per tile cost 200-3700 ms at 4x CPU.
- Tiles are not committed; decide how they reach Vercel (commit 85 MB, or build in CI) before flipping the default.
- Streaming radius 40 m means distant buildings are shell massing until you walk there; the removed districts' shell nodes (glassq, foundry, terraces, halo) still render in both modes.
- World-look p95 (< 50 ms) flakes under a loaded machine; it passes alone.
