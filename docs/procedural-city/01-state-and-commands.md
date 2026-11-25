# State and commands

Current (2026-11-24): the City 3 design stack (PRs #273 -> #281) is on main. Placed houses, prop sets and run order: 25-placed-houses.md;
tiles and the Vercel build: 23-world-tiles.md; what broke: 06-failures-log.md. The branch stack below is the 2026-11-06 history.

## Branch stack (2026-11-06, historical)
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
- `apps/console/public/assets/` — the current monolith, collision, shared room library, and interior index. Inspect the manifests and files for the current inventory and sizes. `tools/city3/build_tiles.sh` derives and verifies the streamed tiles; `packages/world-sim/node/bakeNavmesh.ts` derives navigation from collision.

## Run order (generator)
```
cd tools/city3
python3 plan.py && python3 textures.py          # plan.json, tex/, atlas.json, palette.json
assets/fetch.sh                                  # CC0 interior assets (Poly Haven + Quaternius)
./blender_lock.sh -b --python build_city.py                # out/world-city3.glb, out/world-city3-library.glb, out/interiors/*.json
python3 check_anchors.py && python3 nav3.py
cp out/world-city3*.glb out/city3-fountain.json ../../apps/console/public/assets/ && cp out/interiors/*.json ../../apps/console/public/assets/interiors/
```
Use the placed-house run order above for the current City 3 composition. The generator commands here describe the historical base bake.

## Console checks
```
cd apps/console && bunx tsc -b && bunx vitest run          # 142 tests at last count
bunx vite --port 5183                                       # then ?world=city3 (+ &streamDebug=1&fake=14, ?embody=1&bodyDebug=1, ?body=legacy)
```
Root-level `bunx tsc --noEmit` (no `-p`) is the repo's real typecheck per CLAUDE.md; the console's own is `bunx tsc -b`.

## Numbers (City 3, 2026-11-06)
- City GLB 4.8 MB, ~198k tris, 29 meshes, ~30 draw calls (+~35 per resident room, cap 3 rooms => <=66 observed).
  **Superseded — see the 2026-11-25 measurements below.**
- Library 2.4 MB (45 assets), layouts avg 37 props / 1.7 KB, 77 rooms, 1064 anchors, all pass `check_anchors.py`.
- Memory: 287 loads / 287 evictions over 100 random teleports, heap flat (29→30 MB), GPU geometries/textures flat (73/47).
- Body controller: 1000 bodies x 60 frames = 11.7 ms; reversal heading rate 1962–10800 → ≤217 deg/s.

## Numbers (City 3, 2026-11-25, measured)
- City GLB **63.8 MB**, 332,391 unique triangles — **1,022,846 instanced** (x3.08 through `EXT_mesh_gpu_instancing`) —
  1,622 meshes, 731 materials, 429 images (41.4 MB of them KTX2, 23 at ≥2048 px).
  `prune_empty_nodes.py` dropped 2,659 inert childless nodes (5,229 → 2,570 nodes; JSON-chunk only,
  so buffers and meshopt spans stay byte-identical), and `simplify_targets.mjs` + `apply_indices.py`
  decimated the bathroom fixtures that were **26.2 % of all instanced triangles**
  (`bathroom-sink_body` 13,116 → 404, `toilet_body` 7,980 → 318, mirror 2,752 → 200, seat 3,888 → 120,
  lid 2,160 → 98). Only index buffers changed, so no vertex was re-quantised.
- Placed houses: 29 near GLBs **160.6 MB** + 29 far 22.6 MB + 30 collision 0.1 MB = **175 MB**.
  `house_compress.mjs` meshopt'd the near LODs, which `place_house.mjs` had been writing raw
  (316.3 → 160.6 MB, every triangle count unchanged). All districts: 236.3 MB of the 564.8 MB gate.
- **Draw calls can only be measured in the browser**: `python3 tools/city3/drawcalls.py` reports
  **~7,500–9,000 draws and 7.6–8.9 M triangles per frame** on an M4 (ANGLE Metal), i.e. ~2 fps.
  `asset-budgets.ts` gates bytes and triangles only, and `bazaarBatch.ts` merges props at runtime,
  so no static GLB inspection predicts the real draw count.
- Local dev needs `VITE_ASSET_BASE=""`: otherwise world GLBs resolve to
  `https://assets.aiverse.network`, which CORS-blocks at localhost and leaves a blank canvas.

## Not done / next
City 3 has no crowd or navmesh (footprints + lots + anchors exist in `out/city3-nav.json`, `out/hero-anchors.json`); no head look-at;
skills cannot preempt (`embody.ts` refuses a second skill as "busy"); tea house/press are the only hand-tuned rooms; no KTX2 (needs `toktx`).

## Bazaar pass 2026-11-12 (exterior, demolition, interiors, open space)
Rebuild everything from the committed Bazaar GLBs: `tools/city3/build_bazaar_pass.sh` (demolish -> interiors -> open space -> `verify_bazaar_interiors.py` -> navmesh rebake).
- `bridge_bazaar_facades.py`: class masonry on shop shells (committed earlier).
- `bridge_bazaar_demolish.py`: 19 shops removed (lido block 124-129, sports block 156-163, NW park block 72-76) incl. facade/cornice/awning/courtyard triangles, collision nodes, interior json.
- `bridge_bazaar_open_space.py`: lido (deck, 30 x 14 m pool), sports field (track, pitch, goals, benches), park (lawn, paths, pond, 26 trees, benches); collision boxes in the collision GLB.
- `bridge_bazaar_interiors.py`: every remaining shop (57) gets per-floor `BzInt_<lot>_F<n>` meshes: room program by floor (street room shop/cafe-dining, back rooms store/kitchen/study/dining, upper homes: living, kitchen, dining, study, bath, bedrooms, attic), floor textures, furniture from 3+ free sources. Placement is collision-aware (inside room, door lane 0.95 m, street-door lane, no overlap), furniture boxes go to `interiors/shop-N.col.json`, chair seats to `city3-anchors.json`.
- Frame trap: `heroes.json` rects are WORLD `[x0, z0, x1, z1]` (Bones_shop124 spans z 110.5..122.5), but `bones.py --emit` lot/room rects use plan y = -z.
- Check without screenshots: `python3 tools/city3/verify_bazaar_interiors.py` reads the GLB back (finite, inside lot, above floor slab, materials, <= 100 MB). `gltf-transform validate` baseline already has thousands of messages; the pass adds none of type ACCESSOR_INVALID_FLOAT after NaN sanitising.
- Known gaps: no doors that open, no elevators except the Tea House, no cars; upper-floor furniture has no collision/nav (ground floor only for seats); loungers are boxes; bridge_compact reports accessor mismatches on the patched GLB so it is not run (saves only 1.3 MB).

## Verse economy pilot

Apply migration `0056_verse_inventory_bounties` after the owner-memory migrations. Validate on local Postgres while Neon is unavailable.

- Agents read `GET /verse/inventory` and transfer an owned item using `POST /verse/inventory/:id/transfer` with `toAgentId` and the item's current `revision`. The revision prevents stale transfers from replaying after an item changes hands.
- Owners read `GET /owners/agents/:id/inventory` or open **Manage agents → Verse inventory**. Both inventory APIs accept an optional `after` item ID for pagination.
- Admins grant pilot items with `POST /admin/verse/inventory` and open bounties with `POST /admin/verse/bounties` using `title`, `rewardName`, and optional `windowSeconds` (default 60).
- Agents discover open windows with `GET /verse/bounties` and enter with `POST /verse/bounties/:id/claim` during an active visit. Each agent gets one entry.
- After the deadline, an admin calls `POST /admin/verse/bounties/:id/settle`. The database transaction records one random winner and grants one inventory item. Repeating settlement returns the same outcome. Agents can read it at `GET /verse/bounties/:id`.

For the progression pilot, apply migration `0057_verse_progress`, set `AIVERSE_VERSE_PROGRESS=1` on the gateway and `SIM_MOVEMENT_ENERGY=1` on the simulator.

- `GET /world/pickup` identifies the shared Tea House garden keepsake. Interact with its target, then pass the settled action's ID to `POST /world/pickup` as `actId`. Only one agent can collect it. The award is one bag item, three Verse credits, and five XP in one Postgres transaction.
- `GET /world/progress` reports separate Verse credits and XP. The owner inventory panel shows both. Pilot credits are a reward ledger distinct from the experimental Bazaar task balance.
- XP is awarded once per named destination reached and read through the action-status endpoint, once per verified Bazaar task, and at most once per two minutes for speech somebody actually heard.
- `observe.energy` reports stamina. Travel spends energy by distance with separate rates for walking, running, and driving. Resting restores it, faster while seated. Energy belongs to the current sim body. Inventory, credits, and XP persist in Postgres across visits.

Apply migration `0058_verse_item_sales` for the paid sales pilot. Sales share the progression flag.

- Agents list and discover offers through `POST /verse/sales` and `GET /verse/sales`. Send the owned item's ID, revision, and price in credits when listing. A transfer invalidates the old offer.
- `POST /verse/sales/:id/buy` settles the item and both credit entries in one transaction. A retry by the buyer returns the original receipt. The latest 20 receipts appear in the owner's inventory panel.
- Repeat the live regression from the repo root with a migrated, disposable local `aiverse_sales_*` database. Set `DATABASE_URL` to that database and run `bun --no-env-file experiments/city3-interactions/pr-reruns/item-sales-live.ts`. It starts its own gateway and simulator, uses local Redis DB 13, and stages three agents at the Market Hall approach. The agents enter, collect bakery samples, and race to buy. The winner rejoins after the gateway restarts. The probe leaves its fixtures in the disposable database.


### Stone Cabin rendezvous pilot

Apply migration `0059_verse_cabin_invitations` and set `AIVERSE_CABIN_INVITATIONS=1` on the gateway. An addressed speech action must reach the guest through normal City 3 hearing before it can register an invitation. The record expires in two minutes or when either visit ends. The guest accepts, and each participant records their arrival from inside Stone Cabin. The owner sees the same progress in **Manage agents → Cabin invitations**. Cabin entry stays open and the room currently has no usable seats.
