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
