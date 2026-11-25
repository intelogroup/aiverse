# Headless Blender: what it can do here (measured 2026-11-25)

Not a wish list - every row below was run through `tools/city3/probe_blender.py` on this machine
(Blender **5.4.0 Alpha**, macOS arm64, `-b --factory-startup`) and the numbers are that run's.
Re-run it any time:

```bash
tools/city3/blender_lock.sh -b --factory-startup --python tools/city3/probe_blender.py -- --world
# report: /tmp/blender-probe.json   render: /tmp/probe-eevee.png
```

## Scene, mesh, UV, bake

| Capability | Call | Measured |
|---|---|---|
| Open the shipped world | `bpy.ops.import_scene.gltf(filepath="world-city3.glb")` | **63.8 MB, 2 570 nodes, 1 622 meshes, 731 materials, 429 images, 291 846 tris, 2.0 s** |
| Open the loft kit | same, `interiors/modern-loft-interior.glb` | 8.58 MB, 110 441 tris, 26/26 objects with UVs, 0.2 s |
| UVs from a bare mesh | `bpy.ops.uv.smart_project(angle_limit, island_margin)` | 1 `UVMap` on a cube |
| Decimate / bevel / etc. | `obj.modifiers.new(..., "DECIMATE"/"BEVEL")` + `modifier_apply` | 12 → 6 tris after 0.5 decimate |
| **Bake AO with Cycles** | `scene.cycles.samples=8; bpy.ops.object.bake(type="AO")` | 128² image, pixels written, **48 ms** |
| Texture write | `img.file_format; img.save()` | JPEG 5.2 KB, **WebP 2.5 KB**, PNG 2.7 KB from the same image |
| Image formats | `Image.bl_rna.properties["file_format"]` | AVIF, JPEG, PNG, **WEBP**, OPEN_EXR(+multilayer), TIFF, TARGA, HDR, FFMPEG |

## Engines

- `RenderSettings.engine` enum exposes **`BLENDER_EEVEE`** (EEVEE Next kept the id) and Cycles via its
  addon. A headless 320×200 EEVEE render of the bake cube wrote a 40 KB PNG in **606 ms** - real GPU
  rendering in `-b`, no display server.
- Cycles runs on CPU here (`scene.cycles.device="CPU"`) and is the path for bakes and denoised stills.

## glTF features the importer actually decodes

The world GLB declares, and the import walked:

```
EXT_mesh_gpu_instancing      KHR_materials_transmission   KHR_texture_transform
EXT_meshopt_compression      KHR_materials_volume         KHR_texture_basisu (KTX2)
KHR_lights_punctual          KHR_materials_specular       KHR_materials_ior
KHR_materials_emissive_strength
```

Instancing and meshopt are decompressed on import (4 084 mesh objects from 1 622 mesh entries).
A sampled map came back with real pixels and re-encoded (see the deep pass below); the basisu/KTX2
path was not exercised map by map, so treat a specific KTX2 texture as unproven until one is read.

## Gaussian splats - native, import-only

```python
bpy.ops.wm.spz_import(filepath="apps/console/splat-trial/bazaar-stall-262k.spz")
```

Imports the 2.59 MB file as a **`POINTCLOUD`** object with **262 144 points** and the Gaussian
attributes exposed for scripting:

```
position | radiance:base | scale | rotation
```

So splats can be loaded, transformed, filtered, joined with meshes, and their attributes read or
rewritten (`o.data.attributes["radiance:base"].data`). **There is no `spz_export`** in this build -
round-tripping back to Spark has to go through the web side.

**They render, but not as Gaussians.** A 480×270 EEVEE render of the imported cloud wrote 165 KB,
99.9 % of pixels lit, mean luma 0.289 (`/tmp/splat-render.png`, reproduced by
`probe_world_deep.py`): the stall, the fruit on the counter and the coloured blobs are all there, but
the gaussians draw as hard-edged point billboards - squares, no elliptical falloff. Good for
layout/preview; the quality path stays `@sparkjsdev/spark` in the console.


## Add-ons and extensions (35 available, script-manageable)

Installed from `extensions.blender.org` and user repos, all importable headless:

```
Bagapie  arch_generator  attribute_baker  attribute_sweep  booltron  camera_shakify
cell_fracture  cloudrig  dynamic_sky  easy_tree  extra_mesh_objects  jiggle_physics
maze_generator_pro  modern_primitive  node_to_python  retarget  sun_position
texture_pipeline_studio  SuperDuperBatchExporter   (bl_ext.blender_org.*)
agent_3d  blender_mcp  hydra_storm  node_wrangler  rigify  cycles
io_scene_gltf2  io_scene_fbx  io_mesh_uv_layout  pose_library  bl_pkg   (user/system)
```

They are manageable from Python too: `bpy.ops.extensions.package_install`,
`repo_sync`, `package_upgrade_all`, `package_uninstall`. The two that carry this repo's pipeline are
`attribute_baker`/`texture_pipeline_studio` (PBR bakes from high to low poly) and `blender_mcp`
(live bridge to the running app).

## .blend round-trip

`wm.save_as_mainfile` → `wm.open_mainfile` works headless: a 3-object scene round-trips in 6 ms
(60 KB), so a `.blend` can be the working format between probe runs and exports.

## Texture inpainting: repair vs generation

- **Repair works today** with LaMa on CPU (measured below): 1.6 s per 5122 map via
  `tools/city3/inpaint_texture.py` - holes, seams, watermarks, tiling artefacts.
- **Generation** needs a diffusion checkpoint: `diffusers` and `torch` are installed but no SD/Flux/inpaint
  model is cached (`~/.cache/huggingface/hub` holds bge, Phonon TTS, whisper) and no ComfyUI listens on
  `:8188`. A download + VRAM decision, not a Blender one.
- Blender-side, model-free: `attribute_baker`/`texture_pipeline_studio` bakes, and the texture-paint clone
  stamp (`bpy.ops.paint.*`).

## Deep pass: world → edits → .blend → back out (measured)

`tools/city3/probe_world_deep.py` takes the shipped world all the way round and back:

| Step | Result |
|---|---|
| Import `world-city3.glb` | **2.2 s**, 4 279 objects, 4 058 meshes, 297 materials, 231 images |
| Geometry after import | **2 650 274 tris** — the GLB's accessor sum is 291 846, because `EXT_mesh_gpu_instancing` + shared mesh entries expand into one object per instance. Budget against the expanded number, not the file's |
| Per-object edit | heaviest mesh `Props`: 20 718 → 10 359 tris (decimate), UVMap present, material `palette`, custom property written |
| Texture out of the world | material `BzCitadel_grass` → `leafy_grass_diff` at 512²: **WebP 123.8 KB, JPEG 118.6 KB, PNG 589.7 KB** |
| Save as `.blend` | **44.0 MB in 0.1 s** |
| Reopen that `.blend` | 4 279 objects, 231 images, and the custom property `deep_probe_tag` survived |
| Export a subset | 10 objects → 31.8 KB GLB with WebP textures, 974 tris |
| Splat render | see above: 165 KB PNG, point billboards, colour intact |

So the working loop is: import GLB → script edits/bakes/textures → save `.blend` as the durable
working file → export GLB subsets. A full-world `.blend` is 44 MB and saves in a tenth of a second,
so checkpointing between experiments is cheap. Note the subset export fell back to the first ten
meshes because no object name starts with `shell_bazaar` in this build - filter by the names the
importer actually produced (`Props`, `Awnings`, `ATTIC_*`, ...), not by the old generator prefixes.

## Unwrap, retopo, rigging (measured)

`tools/city3/probe_model_ops.py`, one run, all six sections green:

| Op | Call | Result |
|---|---|---|
| Smart UV + seam unwrap | `uv.smart_project` → `uv.seams_from_islands` → `uv.unwrap(method="ANGLE_BASED")` → `uv.pack_islands` | sofa: **1 194 seams**, UV bbox **0.011–0.989** (packed across the sheet), 12 303 loops, **617 ms** |
| Quad retopo | `object.quadriflow_remesh(target_faces=400)` | bed 2 715 tris → **327 faces, 327 quads (100 %)**, **294 ms** |
| Voxel remesh | `data.remesh_voxel_size` + `object.voxel_remesh()` | vase 5 000 → **22 888 tris** at voxel 0.005 — density goes *up* unless the voxel size tracks object scale; 209 ms |
| Shrinkwrap retopo | 24×24 grid + `SHRINKWRAP` (PROJECT, Z) + apply | 576-face projection onto the counter, **161 ms** |
| Auto-weighted rig | `armature_add` → bones → `parent_set(type="ARMATURE_AUTO")` | 2 bones, groups `root`/`spine`, **2 712 of 2 715 vertices weighted**, ARMATURE modifier, **175 ms** |
| Rig add-ons | `addon_utils.enable(...)` | **rigify** exposes `fk2ik`, `ik2fk`, `transfer_fk_to_ik/ik_to_fk`, `rotation_pole`, `clear_animation`; `retarget` and `cloudrig` enable but register **no operators** headless |

## AO: vertex colour, not a texture multiply

The first attempt baked AO with Cycles and multiplied it into the base maps. Measured result: **−48 luma,
71 % of pixels darkened**, and per-asset mean AO of 0.03–0.13 — because most of each AO image is
*unbaked black*: several materials share a `palette` atlas, so a per-object UV bake does not line up
with the pixels it is multiplied into. Wrong shape for this library.

The correct pass is `paint.vertex_color_dirt()` (Dirty Vertex Colours) → glTF **COLOR_0**:

```
tools/city3/blender_lock.sh -b --factory-startup --python tools/city3/bake_ao.py
# AO_VCOL 25/25 assets, 32/32 primitives carry COLOR_0, 8.58 -> 9.98 MB in 1.3 s
```

No second UV channel, no extra texture memory, and three.js applies COLOR_0 as soon as the primitive has
it. Costs **+1.4 MB** for the colour attribute and is per-vertex, so it wants the 3.5–8k tris the kit
already carries. Whether to ship it is a look call, not a technical one.

## Textures: KTX2 vs WebP, measured on the same 512² grass map

| Encoding | Bytes | vs PNG | Bits/texel | Notes |
|---|---|---|---|---|
| PNG | 589 654 | 1.0× | 24 | lossless, what the exporter writes by default |
| **WebP q82** | **123 814** | **4.8× smaller** | — | three.js native, `gltf-transform webp`, **no new tool** |
| **KTX2 ETC1S** | **44 093** | **13.4× smaller** | 1.35 | GPU-compressed; transcode at runtime |
| KTX2 UASTC | 256 065 | 2.3× smaller | 7.78 | higher quality, still GPU-compressed |

Which tool to install (verified):

- **`brew install basis_universal`** — what is now installed here (`basisu` 2.50, bottle, no sudo). `basisu -ktx2 file.png` (ETC1S) or `basisu -ktx2 -uastc file.png`, ~0.1 s per 512² map. It writes `.ktx2` but does **not** wire it into a GLB.
- **KTX-Software** (`ktx create/transcode/info`) — the reference toolchain, and the binary `gltf-transform etc1s|uastc` shells out to. There is **no Homebrew formula or cask**; the macOS arm64 release is a `.pkg` (needs sudo).
- Nothing at all for WebP: `gltf-transform webp` is already installed and three.js reads WebP natively.

**Recommendation:** WebP for every texture today (4.8×, zero tooling, works in the current loader).
Add KTX2/ETC1S only where GPU memory or texture-binding count actually bites (large atlases, many
materials), by installing KTX-Software and running `gltf-transform etc1s`; keep `basisu` as the
no-sudo encoder when you only need the `.ktx2` file. The console already preloads a KTX2 transcoder
for the tile pipeline, so the runtime side is in place.

## Inpainting: LaMa on CPU (measured)

```
pip3 install simple-lama-inpainting          # 196 MB checkpoint into ~/.cache/torch
python3 tools/city3/inpaint_texture.py --image TEX.png --mask MASK.png --out FIXED.png
```

- **1.62 s** for a 512² repair (model load 0.2 s, cached) on CPU.
- Quality, measured against the untouched original inside the mask: LaMa fill sits **18.6/255** away, the
  defect it replaced sat **73.0/255** away; fill mean RGB `[148,131,86]` vs the surrounding grass
  `[151,131,90]`. It reconstructs the material, it does not invent one.
- Two traps: this torch is CPU-only, and `simple-lama` calls `torch.jit.load` without a `map_location`, so
  the checkpoint's CUDA tensors fail — `inpaint_texture.py` patches it. `--device mps` is untested for
  TorchScript.
- For *creative* inpainting (new content, not repair) `diffusers` + a checkpoint download is the path;
  none is cached here.

## Practical limits worth knowing

- One Blender at a time: `tools/city3/blender_lock.sh` exists because concurrent headless runs
  starve each other on this box.
- World import is cheap (2 s) but 4 307 objects land in one collection; per-object edits need name
  filters (`shell_*`, `col_props`, `LIB_*`), and the collision meshes live in the separate
  `world-city3-collision.glb`, not the visual file.
- Splat attributes are typed generic attributes, not a dedicated splat datablock: reading them is
  easy, rendering them as Gaussians is the web renderer's job.
