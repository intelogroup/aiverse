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
- Hero buildings (`heroes.json`): `TeaUpper_*` / `PressUpper_*` objects are their upper floors, roof and ceiling;
  the console hides them near the building.
- Interiors stream. `world-city3-library.glb` holds every furnishing once (CC0 imports + procedural pieces, node names `LIB_*`;
  Poly Haven maps reduced to base colour only). Each building is a layout `interiors/<id>.json`:
  `props: [asset, x, y, z, rotY, scale]` in three.js space. The console builds one InstancedMesh per asset primitive over the
  shared library, keeps at most 3 rooms resident, and disposes the instance buffers on eviction (`interiorBuild.ts`, `interiors.ts`).
  To add a room: queue `put(...)` placements in a template, add it to `HERO_SPECS`, rebuild. The tea house still bakes its fittings
  into the city GLB (`hero.py`); converting it to library pieces is the same move as the press.
- Export patches Blender 5.2's meshopt POSITION filter (12-bit shared exponent -> 20-bit separate); without it small
  height offsets (rugs, signs, shutters) snap onto their surfaces.
- Materials are single-sided except glass; anything seen from both sides is emitted twice.
- The GLB uses EXT_meshopt_compression (drei's `useGLTF` decodes it by default). Glass is alpha-blended.
- Needs `libegl1` on a headless Linux box for Blender to start rendering previews (`preview.py`).
