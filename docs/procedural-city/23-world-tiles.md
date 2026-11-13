# World tiles (phone-load plan, option B)
Status 2026-11-13: live and the DEFAULT in builds that contain the tiles (`__TILES_DEFAULT__` in vite.config.ts; `?tiles=0` forces the one-file world, `?tiles=1` forces tiles; a build whose tile step was skipped falls back to the one-file world on its own). Cold start to a walkable spawn is 1.3-1.5 s on Fast 4G (see Numbers); not met on Slow 4G.

## What it is
`world-city3.glb` (91 MB, 35 MB brotli) is cut into tiles that stream by distance, so a phone downloads a small core on the fountain first.
- Build: `tools/city3/build_tiles.sh` (after `build_bazaar_pass.sh`). Steps: `split_world.mjs` (visual, then collision with `--layout` so squares match), `split_shell.mjs`, `verify_tiles.mjs` (the gate, both sets), `tiles_manifest.mjs`.
- Output (generated, NOT committed, ~85 MB): `apps/console/public/assets/tiles/` = content-hashed tile GLBs, `tex/` (textures written once), `col/` (collision tiles), `shell.<hash>.glb`, `districts.json` (tile manifest), stable aliases `core.glb` / `core.col.glb`.
- Grid: 3x3-nested squares around (0,0) over a 486 m root, 18 m cells, so the centre cell of every level contains the spawn. The core is an 18 m square (`--core-half=9`: 78k tris, 0.31 MB geometry + 0.69 MB textures; half 27 carries 5 MB). The Tea House (`--hero=tea:...`) is its own tile because TeaDoorLeaf/TeaElevator edit its door instance and four lift placeholders in one scene.
- Runtime: tiles are the default where the build has them (`tilesMode.ts`: `?tiles=0` off, `?tiles=1` on; it preloads the critical path when the URL has `walk`), `DistrictWorld` streams tiles like districts (`origin`, manifest `streaming`), `tileScenes.ts` lets the Tea components wait for their tile, `WalkColliders.covered` stops bodies at the edge of loaded collision.

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

## Numbers (emulated phone: 390x844 @3x, cold isolated context, ONE test tab, real GPU Apple M4)
| | monolith | tiles, textures blocking | tiles, textures deferred |
|---|---|---|---|
| Fast 4G, 1x CPU | ~35 s download | 4.6 s (2.3 MB) | 1.30 s (0.53 MB) |
| Fast 4G, 4x CPU | ~52 s | 6.5-14 s* | 1.46 s, 1.47 s (0.76 MB) |
| Slow 4G, 4x CPU | | | 6.6 s (JS bundle alone takes 3 s) |
*Those runs had 4-8 other WebGL tabs open and were inflated; never time with other tabs rendering.
What gated the 4.6 s: the core's 1.5 MB of textures, not its 82 KB of geometry (the last core texture landed at 4.44 s, the world mounted at 4.46 s). `deferTextures.ts` answers each external-uri texture with a neutral placeholder and swaps the real one in after parse, so the scene mounts and the body walks at once; the plaza reads as flat grey for a moment on a slow link. Walkable is measured as `window.__walk.state()` non-null (`?walkDebug=1`).
Before that: the first profile blamed shader link checks (`checkShaderErrors`) and character parsing, which was real main-thread cost but not the wait; the main thread was idle while the textures downloaded.

## Open
- Slow networks: the 412 KB JS bundle is the floor (3 s at Slow 4G); only code-splitting the console shell would move that. Preloading core.glb / manifest from index.html (not from JS) would save ~0.5 s now that tiles are the default.
- Deferred textures change the first frames: grey ground until the images land. Core textures are 1.5 MB (six 1024 px maps); lower-res core textures would shorten that window.
- Each tile decodes its own copy of shared textures (GPU memory), and collision BVH builds per tile cost 200-3700 ms at 4x CPU.
- Tiles are not committed: Vercel generates them in `bun run build` (`build:tiles`, PR #166). If that step fails the build still succeeds and serves the one-file world, so check the live `/assets/tiles/districts.json` after a deploy. Default flipped in PR #167 (merged 2026-11-13, live on aiverse.network: districts.json 200, bundle references core.glb).
- Streaming radius 40 m means distant buildings are shell massing until you walk there; the removed districts' shell nodes (glassq, foundry, terraces, halo) still render in both modes.
- `tests/world-look.test.ts` p95 (< 50 ms) is not a random flake and not caused by tiles: it measures 57-65 ms alone on an idle M4 (median ~22 ms), at the commit that added the adaptive pass (656c7af, which reported 18.5 ms) and at three later ones. The cost is in shops (shop-168/176 60-77 ms, shop-52..68 40-58 ms); under CPU load it triples. CI passes or fails by runner speed. Fix the look cost or make the test relative; not yet done.
