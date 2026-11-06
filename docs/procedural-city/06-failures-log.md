# Failures log (symptom → root cause → fix)

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | `blender -b` render: `Couldn't open libEGL.so.1` | headless container lacks GL libs | `apt-get install libegl1 libgl1 ...` |
| 2 | Plan script crashed `unhashable type: list` | JSON turns tuples into lists | `tuple(bd["block"])` |
| 3 | Grey triangles / holes on pitched roofs | hip-roof faces called with eave/ridge points swapped (bow-tie quads) | pass `(E0,E1,T0,T1)` with T0 above E0 |
| 4 | Concentric rings on water/plaza/roofs in three | shadow acne (bias 0.00015 too small for a 440 m frustum) | bias −0.0004, normalBias 0.8, water receives no shadow |
| 5 | Awnings/canopies wrong colour rows | texture saved flipped; row index mapping wrong | rows are bottom-up in y-up arrays |
| 6 | Hero sign text smeared | 512x128 cell stretched over 21 m | 4 m x 1 m (4:1) board |
| 7 | Sign half dark/striped | fascia quad 2 mm in front of its frame box (z-fight) | 4 cm gap; ≥3 cm rule |
| 8 | Balcony slab at sign height | slab placed 0.8 m below window base instead of floor | `zf = zb − 0.15` |
| 9 | Rugs invisible / one triangle | meshopt 12-bit shared-exponent position filter crushed 4 cm height | patch to 20-bit separate exponents |
| 10 | Everything exported `doubleSided` | Blender default | `use_backface_culling = True` (glass exempt) |
| 11 | Press GLB 3.4 MB per building | fittings baked per building, duplicate textures | shared library + layout JSON + instancing (2.0 MB once) |
| 12 | "Built" rooms drew nothing | `useMemo` handle disposed by StrictMode effect cleanup | build in effect, keep in state |
| 13 | Cutaway opened the wrong building | picked by camera position | pick by orbit target footprint |
| 14 | Neighbour wall dithered at cut | clip plane coplanar with the wall | inset box 12 cm on party-wall sides |
| 15 | Ceiling beams look like a pergola when cut | beams sit below the clip plane | removed beams |
| 16 | 63 anchor conflicts across 77 rooms | stand approach on the wrong side (landed on counters/tables); back-row chairs sharing stand points with stools | `side=-1` for stand/chair anchors; stagger rows; checker |
| 17 | Library tables collided with armchairs | fixed positions ignoring the lounge corner | restrict table x-range near the corner |
| 18 | Poly Haven API 403 | default Python User-Agent | send `User-Agent: aiverse-city3-builder/1.0` |
| 19 | Imported asset `StructRNA removed` | `bpy.ops.object.join` deleted source objects I still referenced | store names, re-fetch by name |
| 20 | Turn clip yaw "overshoots to 250%" | measured with a hip-bone local axis | measure from the two upper-leg joints in three space |
| 21 | Body twisted 59° during turn clip | clips start 62° off Idle; I cancelled only the swing | cancel `TURN_YAW0 + yaw` |
| 22 | Heredoc in `$(...)` broke `git commit` | shell quoting | message to a file, `git commit -F` |
| 23 | Foot-slide metric "5–12× better" | fewer low-foot frames while stepping | replaced by the rigid-fit planting test (0.6 mm) |
| 24 | My unit tests failed 3 times | my expectations were wrong (hysteresis radii, `getMatrixAt` returns void, thresholds) | read the failing assertion before touching code |
| 25 | Kenney / Poly Pizza downloads | blocked (403) from the container | use Poly Haven API + Quaternius via OpenGameArt |
| Bazaar lit windows (translucent emissive pane 2-6 cm in front of upper windows, `win_glow`) | Pane mesh loaded (942 quads, correct positions, material state fine) but never visible with depth test on, even forced opaque red; visible only with depthTest off. Cause NOT found (polygonOffset, clip planes, 6 cm offset all ruled out). Reverted. Next try: emissive twin of the facade atlas, or per-bay atlas variants. |
| 26 | Agora 2 spike (2026-11-06, scratch only, stopped) | Rebuild the Lobby from CC0 kits: Quaternius Modular Sci-Fi MegaKit + Kenney Modular Space Kit + Poly Haven rock scans + scripted glue (deck, rings, hologlobe, trees). Worked: flipped rock scan under the hub, kit columns/door once textured, bloom in Blender 5 via `scene.compositing_node_group` + Glare `Type="Bloom"`. Failed: MegaKit glTFs reference textures by bare name (need `Textures/*.png` beside each .gltf, else magenta); flipped `mountainside` reads as a stump, not a spire; generic corridor kits have no floating-island hero pieces. Stopped: closing the gap to the concept needed too much hand-shaping. Current Agora kept. |
| 27 | `NameError: _principled` in a district script | `from mkit import *` skips underscore names | import it explicitly (`from mkit import _principled`) |
| 28 | Playwright `.mjs` harness: `ERR_MODULE_NOT_FOUND` | ESM ignores `NODE_PATH` | `.cjs` script with `require`, `NODE_PATH=/opt/node22/lib/node_modules` |
| 29 | 4th island never streamed at the Bazaar centre (silent) | `MAX_STREAMED=3` with four neighbours all exactly 220 m away | cap 4 (`districts.ts`) |
| 30 | Close-up screenshot showed only a wall/fin | camera at a fixed street-level point landed inside a building | check `out/<district>-plan.json` for a free spot before placing close cameras |
| 31 | Palm fronds turned to shards | decimated a geometric-leaf palm (BlendSwap #20393, 37k tris) to ~1.4k | alpha cards with a frond texture (BlendSwap #5812) |
| 32 | Festoon wires rendered as 1–2 m dark slabs (Bazaar plaza ring) | `string_lights` drew each wire segment as an axis-aligned box over the segment's bounding box: fine on an axis, a slab on any diagonal | thin crossed-quad ribbon along the segment (`details.py`) |
| 33 | USDZ party table stood on its end | `assets_kit` cleared the parent Empty, which holds USD's Y-up → Z-up rotation | for `source="usdz"` keep `matrix_world` when unparenting |
| 34 | Every party cup came out red | each USDZ holds `textures/Texture_4_ffffff.png`; importing `.usdz` directly unpacks to one shared temp dir and the importer reuses the first image with that path | unzip each USDZ to `assets/_usdx/<key>/` and import its root layer |
| 35 | Hero door detail (2026-11-06): same-colour raised panels read as one flat sheet in three (flat palette texture, no normal map, soft light) | a raised panel in the leaf colour only shows through its side faces, which are almost edge-on at street angles | 3 cm flat `cream` bead strips 2 cm proud of each panel (`doors._bead`, 8 tris per panel). Brass studs on the iron straps for the same reason (iron on iron vanished) |
| 36 | Wanted to instance the whole door, but leaf colour (6) x style (5) = 30 variants would be 90 extra draw calls | EXT_mesh_gpu_instancing needs identical mesh per node; colour is baked in the palette UV | split: colour-independent static part (frame, glass, handle, kick plate, canopy, lamp, steps, plaque) = 5 meshes under `inst_door_*` (10 primitives); leaf + 7-seg house number = bucketed in the shared palette mesh |
| 37 | Hero door detail must not reshuffle the city | `hero_ground` and `rr_` share RNG streams with interiors and sidewalk dressing; any extra draw changes every later layout and anchor | style and number come from their own `random.Random(9100+idx)`; verified `out/heroes.json` and `hero-anchors.json` byte-identical before/after |
| 38 | Playwright screenshot of City 3 timed out at the default 30 s; vite on 5391 was another agent's | swiftshader needs ~90 s per frame at this scene size; port already taken | `screenshot({timeout:180000})`, read the port vite prints (5392), 900x560 viewport, run as a background job |

