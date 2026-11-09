# Districts (beyond 1000 m): Glass Quarter, Foundry Wharf, Garden Terraces, Halo Lagoon, bridges, themes

## World
Islands of 360x360 m on a 400 m pitch joined by 40 m water gaps + 20 m road bridges (`links.py`). Bazaar (0,0) resident; Glass Quarter north
(three z=-400), Foundry Wharf east (x=+400). Total span 1160 m. Manifest: `apps/console/public/assets/districts.json` (districts, themes, links).
Garden Terraces west (x=-400) is built (`terraces.py`: stepped stucco terraces with timber screens and green roofs, pool villas, canal gardens, 258k tris / 8.8 MB). Halo Lagoon south (z=+400) is built (see below). Run `links.py -- N E W S` only for islands that exist (a bridge to nothing looks wrong); `world-links.glb` now has N, E, W, S bridges.

## Pipeline (all under tools/city3, run in this order)
`python3 assets/fetch_textures.py <ids>` (Poly Haven CC0, UA header) -> `python3 mtex.py` (tex_m/, atlases, palette_m, tinted/grayed PBR sets)
-> `blender -b --python glassq.py|foundry.py|links.py` -> copy `out/world-*.glb` to `apps/console/public/assets/`.
Preview: `mprev.py` (Blender EEVEE, ~30 s/shot, CPU-heavy) — prefer the web harness `dshot.mjs`-style Playwright shots of `?world=city3&districtDebug=1`
(`window.__districts.cam(pos,target)`), and only render Blender for final looks.

## Runtime
`districts.ts` (pure, tested): `planDistricts` (load<=330 m from the orbit target, keep<=520 m, cap 4 streamed; was 3, see Halo notes), `blendTheme` (smoothstep over 140 m).
`DistrictWorld.tsx`: GLTFLoader+meshopt, full dispose on eviction, sky dome shader, water plane at y=-1.25 (Bazaar's own water hidden), PMREM env rebuilt only when
the sky moves (`themeDelta>0.04`), key light follows the target on a 40 m snap grid, `night` scales emissive of materials named glass/msign/led.

## What worked
- Curtain wall = atlas of 8 one-storey x 3-bay tiles (+ emissive twin for lit rooms) on per-floor quads, real fins/slab edges/corner columns; dusk theme makes it read.
- World-anchored metre UVs (`u/tile, z/tile`) let overlapping coplanar quads and neighbouring walls match, so no z-fight from duplicated ground.
- Per-block `grp()` buckets => per-block objects (culling) while ground stays global.
- Tinting Poly Haven sets (brick_red from plaster_brick_pattern, container colours from corrugated_iron) gives variety without new downloads.

## What failed / cost time
- First build 774k tris / 29 MB: tree+shrub blobs dominated (12x7 ico). Fix: 8x5 blobs, fewer per block, bollards 6-sided; now 418k / 14 MB (Glass), 350k / 8.7 MB (Foundry). Still heavy; next: instance trees/lamps.
- Palette names must exist in `mtex.PALM` (KeyError 'panel' when a textured material name was used as a palette colour).
- Stair-stepped arches (axis-aligned boxes) -> use `mkit.beam` (oriented box between two points).
- Blender `mprev.py` renders block the CPU; screenshot timeout needs `timeout:240000` and a small viewport under SwiftShader.
- A worker restart kills the vite dev server: restart before screenshots.

## Sources checked
Poly Haven (CC0, API ok), ambientCG (API reachable, CC0; not used yet — good next source for brick/metal), Kenney (page ok but download link needs browser session — skipped, not circumvented),
Quaternius Downtown MegaKit (CC0, free part via itch.io page, interactive), BlenderKit (needs account sign-in; not scriptable here).

## Next
Halo refinement (below); instancing for trees/lamps; 1024 px glass tiles; sidewalk crowd/navmesh per district; memory test across district load/evict (counters in `window.__districts.stats()`).

## Terraces notes
Bug that cost a build: drawing the recessed stucco quad over the whole window opening hid the glass; build the wall AROUND the opening (side/sill/head strips). Stucco set is tinted x1.28 to read white; the sidewalk uses neutral herringbone, not the warm paver set.

## Halo Lagoon (id "halo", south slot, 2026-11-06)
Centre [0,400], half 180, theme `halo` (golden hour: skyTop [0.2,0.32,0.62], horizon [1.0,0.66,0.4], sun [1.0,0.72,0.46] x2.2, night 0.75).
Build: `python3 mtex.py` -> `python3 halo_tex.py` (MUST be after mtex, before halo: tints plaza_herring->halo_pave, terrazzo->halo_terrazzo,
glass_atlas->halo_glass.jpg into gitignored `tex_m/`) -> `blender -b --python halo.py` (-> `out/world-halo.glb`, `out/halo-plan.json`) -> copy GLB to
`apps/console/public/assets/world-halo.glb`.
Contents: superellipse (n=4) island R 176; hero buttress spire with chrome halo rings at the origin; ringA/ringB ring towers; flareA/flareB flared towers with fins;
three diagrid drums with ribbed glass domes; terraced dome; hex tower; wave terraces; lagoon pool; ring road r60-74; N/S boulevards; green ring; south plaza
fountain; static elevated monorail loop (ellipse 104x100, deck z 9.7) with a parked train; lawns; piers. First pass ~216k tris / 7.8 MB.
`districts.ts` MAX_STREAMED 3->4: all four neighbours are exactly 220 m from the Bazaar centre, so cap 3 always dropped one (cost: ~40 MB of GLBs resident).
In progress: refinement pass (palms = procedural alpha cards with the CC0 BlendSwap frond texture, CC0 street props, cars, yachts). Sources: `07-assets-and-licences.md`.

## Streaming policy (2026-11-09, feat/district-streaming)

The console streams districts; it does not preload the city. Policy lives in
`apps/console/src/features/world/districts.ts` and is enforced by
`DistrictWorld.tsx`:

- The Bazaar (resident) + `world-links.glb` + the far shell are always loaded.
- A streamed district loads when the camera/walker focus comes within
  **90 m** of its edge (`LOAD_RADIUS`); it unloads only beyond **300 m**
  (`KEEP_RADIUS`) and only after a **20 s grace** (`EVICT_GRACE_MS`).
  Resident cap **3** streamed districts (2 on touch devices, via
  `streamCap` from `GlbWorld`).
- Movement direction prefetches: focus velocity x 6 s (clamped to 240 m)
  may add loads; it never keeps a district alive.
- `apps/console/public/assets/world-shell.glb` (built by
  `tools/city3/build_shell.py`, ~2.3 MB) is footprint massing of all five
  districts — box per substantial building, flat plates for slabs, one
  island plate per district — always resident, and each district's shell
  group hides the moment its detailed GLB lands, so no viewpoint ever sees
  a hole. A failed district load retries once after 3 s, then warns and
  the shell keeps covering.
- `?world=full` restores load-everything behaviour for debugging.
- Load/unload/retry events are recorded in a ring buffer:
  `window.__districts.events()` (with `?districtDebug=1`).
- History: the old policy (load 330 / keep 520 / cap 4, no grace) loaded
  all four neighbours at spawn (~93 MB world bytes per session) because
  every district sits within 220 m of the Bazaar centre — streaming in
  name only. Per-district parity was verified by decoded census
  (`tools/city3/split_census.py`): every mesh node of `world-city3.glb`
  and its collision GLB sits inside the Bazaar bounds; the only straddler
  is the legacy Water apron, which the runtime already hides.
