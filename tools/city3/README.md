# City 3 — Sunstone Bazaar generator

Procedural pipeline for `apps/console/public/assets/world-city3.glb` (headless Blender 5.2 + Python/PIL/numpy).

    cd tools/city3
    python3 plan.py                         # layout -> plan.json   (python3 plan_img.py -> top-down plan PNG)
    python3 textures.py                     # tileable textures -> tex/, palette.json, atlas.json
    assets/fetch.sh                         # CC0 interior assets (Poly Haven + Quaternius), see ASSETS.md
    blender -b --python build_city.py       # -> out/world-city3.glb, out/world-city3-library.glb, out/interiors/<id>.json, heroes.json, hero-anchors.json
    python3 check_anchors.py                # seat/stand anchors: on open floor, none shared, facing consistent
    python3 nav3.py                         # out/city3-nav.json: footprints, 158 room lots, hero buildings

Notes
- Units are metres. Blender Y is negated into three.js Z by the glTF export; every walkable surface sits at y = 0.2.
- `kit.py` geometry kit, `details.py` facade/street furniture, `hero.py` the Matchmaker's Tea House interior.
- Rooms: every market-block building (77) gets real openings, glazing, a door and a furnished ground floor. `rooms.py` holds the
  reusable fittings (`piece()`, built once at the origin, front = -Y) and five templates (`tea`, `cafe`, `shop`, `library`, `workshop`);
  `press.py` is the hand-laid Kronikler Press. A template builds no geometry: it queues `put()` placements and records seat anchors.
- Interiors stream. `world-city3-library.glb` holds each furnishing once (CC0 imports reduced to base colour + the procedural pieces, node names
  `LIB_*`). Each room is `interiors/<id>.json` (`props: [asset, x, y, z, rotY, scale]`, three.js space) and `interiors/index.json` lists them with
  footprint, door, lot id and the cut box. The console builds one InstancedMesh per asset primitive over the shared library, keeps at most 3 rooms
  resident, and disposes only the instance buffers on eviction (`interiorBuild.ts`, `interiors.ts`).
- Cutaway: upper floors stay in the merged city meshes. The console clips one building at a time with six shared clipping planes
  (`clipIntersection`, `cutaway.ts`), picked by the orbit target. The box is inset on party-wall sides (a plane lying on a neighbour's wall dithers it)
  and extended past the eaves on street/back sides.
- To add a room type: write a template in `rooms.py` (pieces + `put()` + `add_anchor()`), add it to `TEMPLATES`, rebuild, run `check_anchors.py`.
- Export patches Blender 5.2's meshopt POSITION filter (12-bit shared exponent -> 20-bit separate); without it small
  height offsets (rugs, signs, shutters) snap onto their surfaces.
- Materials are single-sided except glass; anything seen from both sides is emitted twice.
- The GLB uses EXT_meshopt_compression (drei's `useGLTF` decodes it by default). Glass is alpha-blended.
- Needs `libegl1` on a headless Linux box for Blender to start rendering previews (`preview.py`).
