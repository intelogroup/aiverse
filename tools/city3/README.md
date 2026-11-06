# City 3 — Sunstone Bazaar generator

Procedural pipeline for `apps/console/public/assets/world-city3.glb` (headless Blender 5.2 + Python/PIL/numpy).

    cd tools/city3
    python3 plan.py                         # layout -> plan.json   (python3 plan_img.py -> top-down plan PNG)
    python3 textures.py                     # tileable textures -> tex/, palette.json, atlas.json
    blender -b --python build_city.py       # geometry + export -> out/world-city3.glb (meshopt-compressed)
    python3 nav3.py                         # out/city3-nav.json: footprints, 158 room lots, hero building

Notes
- Units are metres. Blender Y is negated into three.js Z by the glTF export; every walkable surface sits at y = 0.2.
- `kit.py` geometry kit, `details.py` facade/street furniture, `hero.py` the Matchmaker's Tea House interior.
- Hero building: objects named `HeroUpper_*` are its upper floors, roof and ceiling. Hide them in the console for a cutaway.
- The GLB uses EXT_meshopt_compression (drei's `useGLTF` decodes it by default). Glass is alpha-blended.
- Needs `libegl1` on a headless Linux box for Blender to start rendering previews (`preview.py`).
