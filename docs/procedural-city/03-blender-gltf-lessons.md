# Blender (headless Python) → glTF: what worked, what to avoid

## Geometry style that scaled (≈200k tris, 29 meshes, 5 s build in Python + ~60 s Blender)
- **Never use bpy.ops for modelling.** Accumulate faces in plain Python `MB` builders keyed by material (`kit.py`): vertex dedup by rounded position,
  per-corner UVs, then `mesh.from_pydata` + `uv_layer.data.foreach_set("uv", flat)` once per material. One object per material = one draw call.
- **`tri/quad(..., out=outward_vector)`** flips winding so the face normal matches the intended outward direction. Removes whole classes of
  inside-out bugs; use it for every face.
- **Wall-local `Frame(a, r, n, z0)`** (`kit.py`): `p(u, t, z)` maps (along wall, out of wall, height) to world. All facade/door/window/sign/balcony
  code is written once in wall space and works on all four sides. `t < 0` is *inside* the building. `fbox(fr, u0,u1,t0,t1,z0,z1,color)` draws an oriented box.
- **Palette swatch trick:** props with flat colours all sample one 64x64 `palette.jpg` (8x8 grid of 8 px swatches, UV = swatch centre) → hundreds of
  coloured props, one material. Emissive things (lamps, clock faces, fire) are a *second* material (`lamp_glow`, exports `KHR_materials_emissive_strength`).
- **Facade atlas per plaster colour** (384x2048, 5 sub-tiles: shopA, shopB, plain, upA, upB). Walls are one quad per floor *per bay* with U = 0..1 per
  bay (or 0..N across a whole wall — texture REPEAT handles it) and V = the sub-tile's range. **6 px gutters, 2 px inset**, or mip bleed shows seams.
- **Proud 3-D detail on top of painted walls** (sills, shutters, flower boxes, balconies, awnings, door stoops, fascia signs) gives real parallax and shadows
  from the orbit camera; painted-only windows look flat from 20 m. Budget: ~34 tris per window, ~60–90 per door.
- **Per-building `random.Random(5000+idx)`**, and per-feature seeds for pieces. A shared global RNG reshuffles the whole city when you add a call.
- **Procedural textures** with numpy: tileable noise = FFT of white noise filtered by `1/f^beta` (naturally periodic). Draw with PIL/numpy in
  *y-up* arrays and flip on save, so V=0 is the bottom. JPEG q≈88; whole city texture set ≈1.4 MB.
- **Text/signs:** PIL + `DejaVuSans-Bold.ttf` (present in the container), auto-shrink font to fit; sign cells are 4:1 — a sign quad whose aspect isn't 4:1
  smears the text (a 21 m x 0.65 m fascia was unreadable; keep it ~4 m x 1 m).
- **Library objects:** origin at bottom-centre, front faces **−Y** (→ +Z in three after export), named `LIB_<key>`. Procedural pieces with several
  materials become ONE object with several material slots (`material_index` per polygon) so the client gets one node per asset.

## Export settings that mattered
```python
bpy.ops.export_scene.gltf(filepath=..., export_format="GLB", export_yup=True, export_apply=True, export_image_format="AUTO"/"JPEG",
    export_texcoords=True, export_normals=True, export_cameras=False, export_lights=False,
    export_meshopt_compression_enable=True, use_selection=True)
```
- **meshopt, not Draco**: drei's `useGLTF` decodes meshopt with no CDN fetch. City GLB 13.7 MB → 3.7 MB.
- **TRAP: Blender 5.2's meshopt POSITION filter is 12-bit with ONE shared exponent** (`io_scene_gltf2/io/exp/meshopt.py`). At x = −37 m that is ≈6 cm of
  height precision: a rug 4 cm above a floor merged into it, and signs/shutters/door panels were being flattened everywhere. No setting exposes it. Patch
  *before* export: `import io_scene_gltf2.io.exp.meshopt as m; m.EXP_FILTER_BITS=20; m.ENCODE_EXP_SHARED_VECTOR=m.ENCODE_EXP_SEPARATE`. Cost +0.8 MB. The
  decoder reads any mode (exponents are per component) so the client needs no change.
- **TRAP: materials export `doubleSided: true` unless `use_backface_culling = True`.** Default double-sided + a pair of opposite-wound quads = z-fighting
  and mirrored text. Make every material single-sided (glass excepted) and emit two-sided pieces twice.
- **Glass (alpha blend)**: `mat.surface_render_method = "BLENDED"` and the Principled Alpha input → glTF `alphaMode: "BLEND"` (verified in the JSON).
- Select with `use_selection=True` to split outputs (city vs library). Remove unused `LIB_` objects before the library export.
- Images: set `export_image_format` to keep JPEG; scale imported images with `img.scale(w,h)` before export (asset textures to 256–512 px).
- Verify any export by reading the GLB JSON: `extensionsUsed`, `alphaMode`, `doubleSided`, node names, image bytes (a 20-line Python snippet is in the harness README).

## Importing third-party assets (`assets_kit.py`)
Import glTF/FBX → join parts → `transform_apply` → Decimate (collapse, triangulate) to a budget → move origin to bottom-centre → **keep base-colour map only**
(drop normal/ARM maps, constant roughness 0.8: texture memory ÷3, nobody sees normals from a spectator camera) → scale images. Quaternius OBJ/FBX are flat
grey (colours live only in the .blend): recolour by material-slot name. 70k-tri photogrammetry plant → 3k tris is fine at spectator distance.

## Axes
Blender (x east, y north, z up) → glTF/three (x, z_t = −y, y_t = z). Rotation about Blender Z by θ equals three `rotation.y = θ`. A prop's "front" (−Y) → +Z.
`heading = atan2(fx, fz)`; positive heading = left turn for a rig facing +Z.

## Things that were fine and need no more thought
Python builders for 200k tris (seconds), vertex dedup by 1 mm rounding, flat shading with split normals done by the exporter, JPEG textures in GLB,
`foreach_set` for UVs, deterministic byte-identical rebuilds.
