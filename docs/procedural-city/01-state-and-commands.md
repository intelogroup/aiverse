# State and commands

## Branch stack (all pushed to origin, no PRs opened)
`feat/city3-view` → `feat/city3-detail` → `feat/city3-streaming` → `feat/city3-rooms` → `feat/body-controller` → `feat/city-districts`

| Branch | What it added |
|---|---|
| `city3-view` | City 3 (Sunstone Bazaar) as a view-only world in `GlbWorld.tsx` (`?world=city3`, "City 3" button) |
| `city3-detail` | Facade detail kit (windows, shutters, balconies, doors, signs, lamps, bunting, café sets), tea house interior, generator moved to `tools/city3/`, cutaway, seat anchors, meshopt precision fix |
| `city3-streaming` | One shared asset library GLB + per-room layout JSON, instanced interiors, LRU planner (`interiors.ts`), memory test |
| `city3-rooms` | 77 furnished rooms from 5 templates (`rooms.py`), clip-box cutaway (`cutaway.ts`), `interiors/index.json` |
| `body-controller` | `bodyController.ts`: smooth heading, turn-in-place clips, speed throttle, planted feet (see 08) |
| `city-districts` | This memory folder + the district world (see below as it lands) |

## Layout
- `tools/city3/` — the generator (Python, runs in headless Blender 5.2 + PIL/numpy):
  `plan.py` layout → `textures.py` tileable textures/atlas/palette → `build_city.py` (uses `kit.py` geometry kit, `details.py` facade+street
  furniture, `hero.py` ground-floor shell, `doors.py` hero entrance doors (5 styles; static part instanced as `inst_door_*`), `rooms.py` pieces+templates, `press.py` hand-laid room, `assets_kit.py` CC0 importer) →
  `nav3.py`, `check_anchors.py`. Outputs in `tools/city3/out/` (GLBs are gitignored; copies live in `apps/console/public/assets/`).
- `apps/console/src/features/world/` — runtime: `GlbWorld.tsx` (worlds, `ClipCutaway`, `InteriorStreamer`), `city3.ts` (rooms index types, radii),
  `cutaway.ts`, `interiors.ts` + `interiorBuild.ts`, `bodyController.ts`, `CastFigure.tsx`, `locomotion.ts` (Recast crowd).
- `apps/console/public/assets/`: `world-city3.glb` (4.8 MB), `world-city3-library.glb` (2.4 MB), `interiors/*.json` (77 rooms + index). **(2026-11-10: those two sizes are this build session's; on current main the files are 44,653,948 B and 8,055,844 B, with five district GLBs + collision siblings alongside — see the dated note in this folder's README.)**

## Run order (generator)
```
cd tools/city3
python3 plan.py && python3 textures.py          # plan.json, tex/, atlas.json, palette.json
assets/fetch.sh                                  # CC0 interior assets (Poly Haven + Quaternius)
blender -b --python build_city.py                # out/world-city3.glb, out/world-city3-library.glb, out/interiors/*.json
python3 check_anchors.py && python3 nav3.py
cp out/world-city3*.glb out/city3-fountain.json ../../apps/console/public/assets/ && cp out/interiors/*.json ../../apps/console/public/assets/interiors/
```
Rebuild is deterministic: both GLBs reproduce byte-identically (verified with `cmp`).

## Console checks
```
cd apps/console && bunx tsc -b && bunx vitest run          # 142 tests at last count
bunx vite --port 5183                                       # then ?world=city3 (+ &streamDebug=1&fake=14, ?embody=1&bodyDebug=1, ?body=legacy)
```
Root-level `bunx tsc --noEmit` (no `-p`) is the repo's real typecheck per CLAUDE.md; the console's own is `bunx tsc -b`.

## Numbers (City 3, 2026-11-06)
- City GLB 4.8 MB, ~198k tris, 29 meshes, ~30 draw calls (+~35 per resident room, cap 3 rooms => <=66 observed).
- Library 2.4 MB (45 assets), layouts avg 37 props / 1.7 KB, 77 rooms, 1064 anchors, all pass `check_anchors.py`.
- Memory: 287 loads / 287 evictions over 100 random teleports, heap flat (29→30 MB), GPU geometries/textures flat (73/47).
- Body controller: 1000 bodies x 60 frames = 11.7 ms; reversal heading rate 1962–10800 → ≤217 deg/s.

## Not done / next
City 3 has no crowd or navmesh (footprints + lots + anchors exist in `out/city3-nav.json`, `out/hero-anchors.json`); no head look-at;
skills cannot preempt (`embody.ts` refuses a second skill as "busy"); tea house/press are the only hand-tuned rooms; no KTX2 (needs `toktx`).
