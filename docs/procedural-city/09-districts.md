# Districts (beyond 1000 m): Glass Quarter, Foundry Wharf, bridges, themes

## World
Islands of 360x360 m on a 400 m pitch joined by 40 m water gaps + 20 m road bridges (`links.py`). Bazaar (0,0) resident; Glass Quarter north
(three z=-400), Foundry Wharf east (x=+400). Total span 1160 m. Manifest: `apps/console/public/assets/districts.json` (districts, themes, links).
Garden Terraces west (x=-400) is built (`terraces.py`: stepped stucco terraces with timber screens and green roofs, pool villas, canal gardens, 258k tris / 8.8 MB). South is NOT built yet; run `links.py -- N E W S` only for islands that exist (a bridge to nothing looks wrong).

## Pipeline (all under tools/city3, run in this order)
`python3 assets/fetch_textures.py <ids>` (Poly Haven CC0, UA header) -> `python3 mtex.py` (tex_m/, atlases, palette_m, tinted/grayed PBR sets)
-> `blender -b --python glassq.py|foundry.py|links.py` -> copy `out/world-*.glb` to `apps/console/public/assets/`.
Preview: `mprev.py` (Blender EEVEE, ~30 s/shot, CPU-heavy) — prefer the web harness `dshot.mjs`-style Playwright shots of `?world=city3&districtDebug=1`
(`window.__districts.cam(pos,target)`), and only render Blender for final looks.

## Runtime
`districts.ts` (pure, tested): `planDistricts` (load<=330 m from the orbit target, keep<=520 m, cap 3 streamed), `blendTheme` (smoothstep over 140 m).
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
Garden Terraces (W) + a south district; instancing for trees/lamps; 1024 px glass tiles; sidewalk crowd/navmesh per district; memory test across district load/evict (counters in `window.__districts.stats()`).

## Terraces notes
Bug that cost a build: drawing the recessed stucco quad over the whole window opening hid the glass; build the wall AROUND the opening (side/sill/head strips). Stucco set is tinted x1.28 to read white; the sidewalk uses neutral herringbone, not the warm paver set.
