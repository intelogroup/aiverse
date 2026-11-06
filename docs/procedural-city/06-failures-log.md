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
