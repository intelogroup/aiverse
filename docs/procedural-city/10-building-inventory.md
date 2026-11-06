# City 3 building inventory and per-class plan (2026-11-06)

Counts come from `tools/city3/out/*-plan.json`, `heroes.json` and `city3-nav.json`. Bazaar non-hero count is footprints minus heroes: approximate, verify in Blender.

| District | Class | Count | Today | Proposed action |
|---|---|---|---|---|
| Bazaar | Hero shops with interior (shop 40, cafe 15, library 10, workshop 10, press 1, tea 1) | 77 | Hero door + sign + blade, streamed interior, cutaway | Door detail pass (frame, handle, step, awning, door light); 2 featured stay as showcase |
| Bazaar | Other footprints (non-hero) | ~35 | Facade only | Plain doors to detailed doors; decide enterable or not |
| Bazaar | Lots (stalls, props) | 158 | Instanced props | No change |
| Glass Quarter | tower 14, mid 8, podium 4, campus 4 | 30 | Curtain wall, plain storefront boxes | Real storefront doors on 4 podiums (+ campus); lobby doors on towers |
| Foundry Wharf | loft 31, works 1 | 32 | Brick lofts | Roller or industrial doors, loading bays; 1 works hero |
| Garden Terraces | terrace 42, villa 8 | 50 | Stucco terraces | Timber gates and entrance doors; villas get porches |
| Halo Lagoon | spire 1, ring_tower 2, flared 2, diagrid drum 3, terraced dome 1, hex 1, wave terraces 1 | 11 | Landmarks, no entrances | One grand entrance each (11): revolving or portal door, canopy, steps; this is the drive-to target |

**Total: about 235 buildings** (77 enterable). Door budget: only 4 to 6 door models, instanced, so triangle cost stays under ~1%.
