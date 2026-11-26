# Interior taste lab (2026-11-24)

Goal: raise City 3 interiors to archviz quality, using free (CC0/CC-BY) high-poly modern assets. The lab is the control
room where material and lighting recipes are judged in Cycles before anything is ported to three.js.

## Tools built

| Tool | Purpose |
|---|---|
| `tools/city3/kit_interiors.py` | Builds `interior-kit.glb` from Poly Haven sources: join, decimate to budget, real metres, origin bottom-centre, `LIB_<key>` names, diffuse-only materials, 1k JPEG. |
| `tools/city3/kit_preview.py` | Loads the **exported** GLB, prints every asset's dimensions, renders a contact sheet. Doubles as an export check. |
| `tools/city3/taste_lab.py` | A 7.2 × 5.4 × 3.0 m room authored from scratch (parquet, stucco, glazing, skirting, curtains, rug, art, lamp) with Cycles daylight, for material/light iteration. |
| `tools/city3/showcase_room.py` | Renders an arbitrary downloaded room GLB with sky + sun + fill and an auto-fit camera. |
| `tools/city3/assets/fetch_sketchfab_any.py` | Sketchfab downloader that accepts CC0 **and** CC-BY (the repo's original refuses non-CC0), always writing credit + licence to `meta.json`. |
| `tools/city3/assets/fetch_textures_ph.py` | Poly Haven CC0 texture sets at a chosen resolution (diffuse, normal, roughness, AO) + meta. |

## Source findings that cost render cycles

- **Sketchfab titles lie.** `Minimalistic Modern Sofa Set` (101k faces) is a single Tripo-generated chair. Always probe
  dimensions and mesh count before placing; a 20-second Blender probe beats a 30-second render.
- **Units are arbitrary.** In one batch: metres, centimetres (`White Couch "Brent"`: 180 × 88 × 66), and ~10× metres
  (L-sectional: 10.53 × 11.34 × 2.75). Normalise by ratio to a target width, never trust the numbers.
- Sketchfab search exposes the licence as `license.label` ("CC Attribution"), not a slug; the `license` query parameter
  rejects `cc-by`.
- Whole "room" downloads are closed boxes with roofs — usable as reference, not as placeable interiors. Single furniture
  pieces are the usable unit.
- CGTrader needs the real browser (AWS WAF answers plain curl with 202 + empty body); Fab's DOM is virtualised, so read
  page text rather than anchors. Both are reference sources, not bulk asset sources.

## Blender 5.4 alpha API drift (breaks older recipes)

- Sky: `sky_type` enum is `SINGLE_SCATTERING | MULTIPLE_SCATTERING | PREETHAM | HOSEK_WILKIE` — there is no `NISHITA`.
- `ShaderNodeTexSky` has no `dust_density`; probe attributes with `hasattr` before setting.
- `SunLight` has no `.direction`; set the object's rotation from the travel vector
  (`travel = -Vector((cos(el)cos(az), cos(el)sin(az), sin(el)))`, then `to_track_quat("-Z","Y")`).
- EEVEE's engine id is `BLENDER_EEVEE` here, not `BLENDER_EEVEE_NEXT`.
- After `bpy.ops.object.join()`, previously captured object references are dead: look leftovers up by name, never by struct.
- `ShaderNodeMix` socket indices are fragile; wiring base colour from an image into `Principled BSDF` directly and skipping
  tints avoided a whole class of failures. Tint only materials without a diffuse map.

## Useful addons already enabled

`arch_generator`, `Bagapie` (scatter), `attribute_baker` (AO), `dynamic_sky`, `sun_position`, `texture_pipeline_studio`,
`easy_tree`, `modern_primitive`, `node_wrangler`, `blender_mcp` (`agent_3d`), plus the glTF importer/exporter.

## State at the 2-hour mark

`tools/city3/taste_lab.py` renders a furnished daylight interior: glazed wall, herringbone parquet, stucco walls, skirting,
rug, curtains, L-sectional sofa (132k faces, CC-BY), marble coffee table, side table, art, floor lamp.

Known defects, in priority order:

1. **Sofa proportions** — the L-sectional is scaled by its largest dimension, so it reads oversized and overstuffed
   against the room. Needs per-axis fit (width to 2.4 m, check depth) instead of max-dimension scaling.
2. **Rug** — `wool_boucle` tiled at 9 reads as camouflage; needs a plain ground colour with the weave as bump only.
3. **Outside context** — the glazing shows a washed sky/ocean gradient. It needs a city backdrop (the real world's skyline)
   before the shot reads as a place.
4. **Wall/floor palette** — pure white walls and orange parquet clash; needs a warmer off-white and a desaturated oak.
5. **No warm bounce** — the reference shots carry a warm interior fill; the lamp is unlit geometry.
6. **Art** — blank beige canvas; needs content or removal.

## Next rounds

1. Fix the four defects above and re-render the hero view; only then claim a look worth porting.
2. Build a second camera set (window-side reverse, detail of the sofa group) so every change is judged from two angles.
3. Port the winning recipe to three.js: texture scale per material, roughness values, sun angle + shadow box, ambient
   occlusion, and an env-map intensity that matches the Cycles exposure.
4. Place the winning furniture in Stone Cabin (currently `props: 0`), with seats, and verify in the running console.
5. Budget pass: 2k textures for hero pieces, 1k for the rest, kit GLB under ~20 MB, draw calls under budget.

## Round 1 executed (2026-11-25, `feat/modern-loft`)

All six defects fixed in `taste_lab.py` and re-rendered from three cameras — `out/taste/r1-hero.png`,
`r1-windowview.png`, `r1-detail.png` (1280x720, 64 samples, Cycles CPU through `blender_lock.sh`, ~70 s each):

| Defect | Fix | Measured evidence |
|---|---|---|
| 1 sofa proportions | per-axis fit: right tipped imports, scale the longest horizontal axis to target (2.4 m), cap seat+back at 1.05 m and the full bbox at 2.4 m, place analytically | `MEASURE sofa: 2.400 x 2.228 x 0.582 m, floor_z 0.000`, bbox centre exactly on the requested anchor; the raw source is a uniform 4x-oversized 10.53 x 11.34 x 2.75 m |
| 2 rug camouflage | flat ground colour; the wool_boucle weave demoted to normal+roughness only | rug tiles read at floor-level edge density in the tile grid instead of camouflage busyness |
| 3 washed glazing | 18 massing blocks (9-34 m tall) in haze at 28-130 m + a ground plane beyond the glass | window-band edge density 3.3-9 % where the pre-fix sky read 0.0-0.6 % (flat gradient) |
| 4 palette clash | walls flat warm off-white (0.80, 0.78, 0.74); herringbone parquet desaturated (sat 0.55, val 0.86) | global warmth +11..+17 R-B across all three views, no pure-white/orange clash tiles |
| 5 no warm bounce | shade emissive (1.0, 0.78, 0.55 at strength 14) + 110 W warm point at the lamp | the warmest-1 % pixel cluster sits on the practical in every view (mean R-B 44-112) |
| 6 blank art | authored abstract print (PIL, muted to the room palette) at `~/Developer/city3-downloads/art/abstract_loft_01.png` | art-region edge density 15-20 % (was a blank beige slab); zero flat tiles in any view |

New tooling: `tools/city3/taste_report.py` (numeric render read: exposure percentiles, an 8x5 tile
luma/edge grid, the warm-pixel cluster, a blank-tile detector — renders get judged by measurement,
eyeballs tie-break), `taste_lab.py -- --measure` (placed furniture extents without a render), and the
`--detail` camera (sofa-group close-up, the second judging angle of the pair).

### What the sofa taught about glTF imports (all measured, 2026-11-25)

1. **Read the raw bbox once, place analytically.** `matrix_world` reads lag the depsgraph for freshly
   imported and re-parented nodes: world-read placement, a two-pass nudge and a fixed-point loop all
   converged to the same stale endpoint because every correction was computed from a lagging read. The
   fix transforms the 8 raw corners by R.S once and assigns location once — no post-transform reads.
2. **`o.parent = root` in Python does not keep the world transform** (`matrix_parent_inverse` stays
   identity): bake `matrix_basis = matrix_world` around the re-parent or the placed piece silently
   switches to local-space semantics.
3. **The placed empty's origin is not the furniture's centre.** The sofa's origin sits at the L's inner
   corner (raw bbox spans x -1.91..8.61 m), so `root.location` is never the placed centre — verify with
   a bbox (`--measure`), never with location.
4. The Sketchfab sofa is uniformly 4x oversized (10.53 x 11.34 x 2.75 m raw is a 2.63 x 2.83 x 0.69 m
   sectional); the per-axis fit with the height cap lands it at 2.40 x 2.23 x 0.58 m, floor-anchored.
