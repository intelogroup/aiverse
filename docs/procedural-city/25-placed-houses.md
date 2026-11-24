# Placed prebuilt houses (2026-11-24)

The city's buildings are now prebuilt CC0/CC-BY models placed as their own streamed districts, not geometry spliced into `world-city3.glb`
(that file sat at GitHub's 100 MiB limit). User direction: high-poly prebuilt houses, a mix of old and modern, spaced with landscape between them;
our own size budgets do not matter for looks (GitHub's 100 MiB per file does).

## Pipeline and run order

Sources live outside the repo in `~/Developer/city3-downloads/<model>/` (`model.glb` + `meta.json` with author, licence, source). Then:

1. `bash tools/city3/houses.sh` — every placement, one `P` line each (`place_house.mjs`). First use of a model runs `slim_textures.py`
   (textures <= 2048 px, JPEG where opaque) into `slim.glb`. `--asset=NAME` writes one shared GLB pair per model and yaw (`houses/NAME-y<yaw>.glb`
   + `.col.glb`) at (0, 0); each line adds a `house-<id>` district whose `origin` puts it on its lot. Options worth knowing: `--scale`, `--lift`
   (over grass), `--mask` (alpha BLEND cards to MASK, thatch), `--simplify=RATIO`, `--body/--floor/--door/--doorx/--doorhalf/--ceil` (a walkable
   interior: floor sunk to 0.28 m over the walk slab, a door gap with stoop, a ceiling), `--room="Name"` (an enterable room + go_to place).
   Every house is flattened and joined to one draw call per material; spec/gloss materials are converted to metal/rough.
2. `bun tools/city3/house_lods.mjs` — a far stand-in per house GLB (sloppy simplify to ~4 %, 256 px textures) and `farUrl` on each district.
   The console shows far houses (after the world is walkable) until each house's detail streams in.
3. `bun tools/city3/house_budgets.mjs` — rewrites the house section of `apps/console/tests/asset-budgets.ts` (one entry per shared GLB).
4. `python3 tools/city3/bridge_clear_footprints.py` — loose trees, bushes and garden kit under the houses leave the scene.
5. New blocks only: `bridge_garden_block.py --block <name>` (yard mode: lawn, walks, spaced trees) or, for the edge ring,
   `ring_houses.py` (generates the ring lines in `houses.sh`), `bridge_ring_frontage.py` (walks + hedges), `bridge_ring_trees.py`.
6. `bun run packages/world-sim/node/bakeNavmesh.ts`, then console + world-sim + apps/sim tests, `build_tiles.sh`.

Re-running `houses.sh` rewrites every house GLB: every rerun adds ~200-350 MB of new blobs to git history. Do not rerun it for a one-line change;
add the line and run that `P` line alone.

## Clearing a block

`bridge_bazaar_demolish.py` (lots + block rect; rooms keyed by name go with their `lot`), `prune_places.py` (also drops seats/places of rooms that are
gone), `bridge_sweep_orphans.py` (floating facades, shutters, roofs, bunting and balconies; root, uninstanced meshes only),
`bridge_drop_tower.py`, `bridge_drop_planters.py`, `bridge_drop_kenney_shrubs.py`, then `bridge_strip_detached.py` + `bridge_compact.py --drop-dead`
(drops what no scene node uses; keeps the one-accessor-per-view layout the Python tools read).

## State at the end of the 2026-11-24 loop

- 45 placed houses on 26 shared GLBs (Stone Cabin and Zen pavilion walkable rooms, Victorian clock tower in the plaza), 0 shims, 2 original
  buildings left (Troyes hall, Tea House). World GLB 46 MB (plaza/sidewalk textures at 1k). PR chain #273 -> #279 (+ the streets branch), all green.
- Textures: Poly Haven CC0 Leafy Grass (lawns), Cobblestone Floor 08 (plaza), Pavement 03 (sidewalks); midday sky with fbm clouds.
- FPS on the M4 over CDP at 1280x720 matches main or better (plaza 30, ring 60, cabin 20; main 28 / 40 / 20).
- Known: the Shirakawago, villas and ring houses are solid (no interiors); one short grey block on the plot sidewalk. Fixed later the same day:
  the tile-mode aerial's light-blue junction squares (split_lod simplified flat road quads away), the sidewalk stoops (bridge_drop_stoops.py).
- Later on 2026-11-24: four ring repeats swapped for new models (colonial, Hawk Lane Scandinavian, log cabin, Finnish cottage): still 45 placements, now
  on 30 shared GLBs. Light pass: sun shadow box follows the walker, sky HDRI environment, N8AO on desktop, transmission glass as plain
  glass, street props instanced at tile build. Desktop fps 60 at plaza, ring and cabin (was 30 / 60 / 20).
