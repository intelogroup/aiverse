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
2. `bun tools/city3/house_lods.mjs` — a far stand-in per house GLB (attribute-aware simplification, meshopt compression, 256 px textures) and `farUrl` on each district.
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
- Prop sets: `place_props.mjs` builds a `props-<id>` district (one GPU-instanced mesh per model, one collision box per placement); the layout
  lives in a small script per site (`props_lido.mjs`: 24 loungers, 12 parasols, 8 deck chairs round the lido pool, CC-BY, credited). Not
  `house-*`, because five tools read house-* as building footprints; tiles_manifest.mjs and the egg test treat props-* like houses. The old box
  loungers were dropped from BzOpenSpace with `bridge_drop_prims.py`. Rerun after editing the layout: props_lido.mjs, bakeNavmesh, build_tiles.

### Scandi Hawk interior pilot

Hawk Lane (ring-35-0) has a walkable ground floor. The street district
carries the shell, and a room layout loads the separated kitchen fittings and
living-room furniture from `interiors/scandi-hawk-interior.glb`. House rooms
load within 12 m of their door and evict past 30 m. The browser can reuse its
cached library on a return visit.

To regenerate from the credited sources, split the preprocessed Hawk Lane
model with `tools/city3/split_interior.mjs`. Use scale `0.01`, volume
`8.55,16.7,-7.9,1.6`, and cuts
`11.95,13.65,0.03,2.05,1.4,1.85;11.38,13.32,0.03,1.3,3.0,3.3`.
The `--floortex` recipe uses material pattern `Carpet|YZY_Ceiling_2` with
Poly Haven Laminate Floor 02 diffuse and normal maps tiled every 1.7 m.
Place the resulting shell with the Scandi Hawk entry in `houses.sh`,
run `bun tools/city3/scandi_hawk_room.mjs contents.glb interior-kit.glb downloads-dir`
using the split contents and the local Poly Haven kit, then cap room textures
at 1024 px with `slim_textures.py`. Rebuild the one house LOD with
`bun tools/city3/house_lods.mjs scandi-hawk-y0.glb`, rebake collision navmesh,
and run the console tests and tile build.

The Scandi Hawk front door opens on approach from either side. The door leaf
also accepts a nearby click. Browser walking and the sim use the same
door timing and threshold blocker. Route planning and the static navmesh
ignore that blocker so agents can plan through it. An occupied threshold
keeps the door open. The sofa's seat and approach are in
`city3-anchors.json`. The stairs lead to a walkable landing at 3.36 m. The room collision sidecar
uses walkable tread tops with separate blockers at the landing edges. Adjacent
upper rooms remain closed until their collision is authored.

The south loft opens off the landing at the same elevation. Its daybed,
nightstand, and lamp load with the existing house room library. The taller
center aisle gives access to the bed and preserves the route back to the stairs.
The daybed opens toward the aisle. The bed and nightstand sit on the modeled
deck, and both pendants have measured canopy contact within 1 mm. The loft lamp
mounts to the flat ridge face. Agents can enter, use
`sit {sittable:"scandi-hawk-loft-bed"}` to climb and sit on the daybed, wait to
recover energy, stand, and walk downstairs to exit. This uses the existing seated
pose and energy recovery. The ordered staircase points live in the room index.

### Market Hall

The Troyes shell has one public entrance at its existing south recess. The
entry bridge removes four door faces and replaces the solid collision box
with perimeter walls and a lintel. The central aisle stays open between the
bakery, pantry, and produce displays on the west and the checkout and snack
counter on the east. Bakery, produce, cheese, flowers, pantry shelves, checkout, snacks, and
water are named destinations. Four low, double-sided pantry shelves stock
the side aisles and leave the central approach open.
The snack table has two sittable benches, and a quieter rear table has one.
The checkout and the water tap are visible props. The bakery sample uses
the existing Verse pickup catalog. Each agent can collect one sample for
one credit and two XP while progression is enabled. A settled interaction
at the counter is required for the first claim.

Run `bridge_open_market_hall.py --dry-run` against the source GLBs before
applying it. Bake the stall modules with
`tools/city3/blender_lock.sh -b --python-exit-code 1 --python tools/city3/market_hall_mesh.py -- /tmp/market-hall-modules.glb`.
Assemble the runtime library, layout and collision sidecar with
`bun tools/city3/market_hall_room.mjs /tmp/market-hall-modules.glb`, then
rebake navmesh and rebuild tiles. Walk mode loads the interior within 16 m
of the entry and retains it until 55 m so the rear stalls stay loaded while
inside. The hall keeps its roof during the visit. Warm pendant and stall
lights reach beyond the counter tops. Six ceiling-mounted pendants light the side aisles. Cooler high fill reveals the roof
and back wall, and a mid-tone stone floor keeps glare down.

## Lido Terrace

An open-sided pergola on the Lido's south deck shades two pool-facing benches.
The terrace is a streamed prop district with eight collision boxes. The roof
sits 2.6 m above the finished deck and the three-meter poolside route stays
open. Agents can go to `lido-terrace` and sit at either `lido-bench-west` or
`lido-bench-east`. The seat anchors account for the 8 cm difference between
the visual deck and the outdoor walk surface.

Rebuild the original Blender modules with
`tools/city3/blender_lock.sh -b --factory-startup --python-exit-code 1 --python tools/city3/lido_terrace_mesh.py -- /tmp/lido-terrace`,
then run `bun tools/city3/lido_terrace.mjs /tmp/lido-terrace`, rebake the
navmesh, and rebuild the tiles.

## Hawk Lane Commons

The commons uses both existing Hawk Lane gates. A gravel connector runs
behind the hedge and branches to a bench and low sedge beds between Scandi
Hawk and the American house. The latter's lot-specific collision follows the
porch and stair treads and keeps the door solid. The shared house model and
the collision used by its other lots stay intact. Agents can visit
`hawk-lane-commons` and `hawk-lane-neighbor-porch`, and sit at `hawk-lane-bench`.

Bake with `tools/city3/blender_lock.sh -b --factory-startup --python-exit-code 1 --python tools/city3/hawk_commons_mesh.py -- /tmp/hawk-commons`.
Install with `bun tools/city3/hawk_commons.mjs /tmp/hawk-commons`, then
rebake the navmesh and rebuild the tiles. For an older world GLB, run
`bridge_hawk_lane_debris.py` first without `--out` to audit the matched
shutter and trim fragments. Write to a scratch GLB and compact with
`bridge_compact.py --drop-dead` before installing the cleaned world.

The secondary trail behind the commons uses 24 scanned flagstones fitted
into the lawn, and a textured crate stack sits at the waterfront edge.
The pass replaces the old path stamps in `Landscape_edge_631` and the
placeholder stack in `Props`. The trail remains passable and the new
crate collider stays outside the through route.

In a scratch directory run `tools/city3/assets/fetch_polyhaven.py` with
`rock_09 namaqualand_stones_01 wooden_crate_01` using Python 3. Bake the
downloaded sources with `tools/city3/blender_lock.sh -b --factory-startup --python-exit-code 1 --python tools/city3/hawk_lane_finish_mesh.py -- <scratch>`
and install with `bun tools/city3/hawk_lane_finish.mjs <scratch>`.
For an older world GLB, use `bridge_replace_hawk_lane_placeholders.py`
to detach the old geometry and compact its output before rebaking the
navmesh and tiles.

The waterfront overlook uses an oak seating bay on the existing pavement
and a steel railing with an oak handrail. The sea-facing
`hawk-lane-overlook-bench` is reached around either end of the bench, and
the inland side remains a through route. Use `hawk_overlook_mesh.py` through
the Blender lock and pass its output, the commons module directory, and
the Poly Haven `metal_trash_can_1k.gltf` source to
`bun tools/city3/hawk_overlook.mjs <overlook> <commons> <bin-source>`.
For the older world, `bridge_replace_hawk_overlook_bin.py` detaches the
old bin overlapping the bench. Compact the output, rebake the navmesh,
and rebuild the tiles. The oak uses the existing CC0 Oak Wood Planks
maps by Dimitrios Savva from `tools/city3/assets/tea-floors/`.

## Northwest park lawn and Market Hall clerestory

The northwest park's former rectangular basin is open lawn. For an older
build, `bridge_remove_park_pool.py` removes the coping, water, and the
single basin collision box. The Lido pool remains a separate fixture.
Compact the visual world and rebake navigation after applying the pass.

`bridge_hall_clerestory_pilot.py` separates the central south bay from
the Troyes Hall atlas and gives its three panes alpha while keeping the
original ironwork. The existing eave blocks the midday sun at this bay.
The hall layout places a soft, sky-colored fill behind it to approximate
diffuse daylight. The pilot does not require a new source asset.

### Lido and plaza basin water

`basinWater.ts` shades the existing Lido surface in both City 3 stream modes and
the plaza fountain ring. The material uses animated normals, HDRI reflections,
and an analytic ray to shade the basin lining, simulating depth and caustics in
one draw per surface with no additional scene pass. The Lido's authored footprint
is 20–50 m on x and 90–104 m on z, with water at y=0.39 m and coping at y=0.48 m.
The fountain still gets its ring dimensions from `city3-fountain.json`. Water is
visual only. Collision, deck access and fountain jets use their existing data.

The plaza fountain has a separate masonry and bronze fixture GLB, generated from
the same fountain dimensions as the water jets. Run
`tools/city3/blender_lock.sh -b --factory-startup --python tools/city3/fountain_architecture.py -- apps/console/public/assets/fountain-architecture.glb`
after changing the fixture dimensions. The masonry follows the existing collision
ring. The outlet and surface splash use the same ballistic path, with a 1.25 m
horizontal reach and 0.72 s flight time.

A low, chamfered stone plinth anchors the clock tower. Its outline follows a
Blender survey of the scan at y=1.10–1.36 m and leaves at least one metre of
clearance to the island coping. Mosaic paving covers the lower scan skirt and
sits 2.5 cm above the existing fountain collision height. The island is visual only.

## Walk-in ring and plot houses

Maple, Birch, Cedar, Elm, Oak, Willow, Aspen, Linden, Hazel and Rowan use the
original furnished models. The `O` placements in `houses.sh` run
`open_house.py` through `blender_lock.sh` to remove the front door leaf and
generate collision boxes for the interior. Prepare the model's `slim.glb`
first. Use `open_house.py --doors` to inspect candidate door geometry before
choosing the cut bounds.

The placements share a visual and far GLB per model across yaws. Their
collision files are yaw-specific. After changing a doorway or its collision
boxes, rebake the City 3 navmesh and rebuild the tiles. The reachability sweep
checks both `go_to` and `enter`, including that the agent passes the door line.
