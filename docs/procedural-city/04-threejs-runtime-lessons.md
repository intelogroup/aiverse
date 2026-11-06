# three.js / R3F runtime lessons (three ^0.170, R3F 9, drei 10)

## Lighting, tone mapping, shadows
- The console sets `AgXToneMapping`, exposure 1.1 (matches Blender's AgX). It desaturates compared with Blender/ACES previews; judge colours in the console.
- One `directionalLight` per place with an ortho shadow frustum fitted to the play area. For a 440 m frustum on one 2048 map: **`shadow.bias −0.0004`,
  `normalBias 0.8`** (City 2's 0.06 gave concentric acne rings on flat roofs, the plaza and the water). Exclude the water plane from receiving shadows.
- Glare spots on water come from the RoomEnvironment reflected at roughness 0.12; use roughness ≥0.45.
- A flat plane ending at the horizon against the page background looks like a slab. City 2 has the same look; a sky/fog pass is the real fix (planned).

## Clip-box cutaway (opening one building at a time)
- All upper floors live in merged meshes, so hide-by-object does not scale (77 buildings × 5 materials ≈ 385 draw calls). Instead give **city materials**
  six shared `THREE.Plane`s with `clipIntersection = true`, `clipShadows = true`, and `gl.localClippingEnabled = true`. A fragment is discarded only when it is
  on the negative side of ALL planes = inside the box. Planes use **outward normals**. Moving the box only updates uniforms (no recompile).
- Inactive state = top plane constant `+1e6` (never all-negative). Apply to meshes once at mount; skip `InstancedMesh` (furniture must never clip).
- **TRAP: a clip plane lying exactly on a neighbour's wall dithers it** (coplanar precision). Inset the box 12 cm on party-wall sides; extend 0.7 m past the
  eaves on street/back sides. Back-faces culling hides the cut building's own side walls from inside, so the neighbour's wall shows cleanly.
- Pick the room by the **orbit target** (`controls.target` inside the footprint) + camera distance to target, with hysteresis. Picking by camera position
  opened the building across the street. Pure logic in `cutaway.ts` with tests.
- Remove ceiling beams (they sit below the cut plane and read as a pergola from above); the ceiling quad faces down and is culled from above.

## Streaming interiors (library + layout + instancing)
- One library GLB, parsed once via `useGLTF`; index nodes by name `LIB_*`. A room = `InstancedMesh` per asset *primitive* sharing the library's
  geometry and material; instance matrix = placement × the primitive's matrix relative to its asset root.
- **Dispose only what the room owns:** `InstancedMesh.dispose()` frees instance buffers. Disposing shared geometry/material would break other rooms.
- Pure planner `planStreaming` (load ≤140 m, keep ≤200 m, cap 3, nearest-first, ties by id) + tests incl. hysteresis and idempotence.
- `renderer.initTexture(tex)` for every library map right after the library loads moves upload cost off the first draw (upload cannot move to a worker).
- **TRAP (React StrictMode): never `useMemo` an object that your effect cleanup disposes.** Dev double-runs effect cleanup+setup on the same render, so a
  memoised handle came back disposed and empty ("built" but nothing drawn). Build inside the effect, store in state.
- Debug hooks behind `?streamDebug=1` (`window.__city3Stream.snapshot()/teleport()`); `&fake=N` adds synthetic rooms for stress tests.
- Fetch dedupe: rooms sharing a layout fetch it once (in-flight set).

## Misc
- `useGLTF` caches by URL forever; our rooms don't rely on it for disposal. Loading a meshopt GLB through drei works with no extra loader config.
- `gl.info.memory` (geometries/textures) and `gl.info.render.calls/triangles` are the memory/draw-call truth; read them in tests.
- `ShadowTagger` in `GlbWorld` sets cast/receive flags on every mesh, 0.3 s throttle.
- WebGPU: sources disagree on readiness; AgX + bloom + postprocessing make migration risky. Not attempted.
- KTX2/Basis would fix texture upload hitches but needs `toktx` + a transcoder wired into `useGLTF`; not attempted (user: "don't bother now").
