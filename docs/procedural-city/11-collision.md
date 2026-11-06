# Collision GLBs (walker) — tools/city3

Small CLOSED-solid meshes for the capsule walker; never rendered. Objects `col_*`, one grey material, no normals/UVs/textures/meshopt, same frame and
yup export as the visual GLBs. Outputs (copied to `apps/console/public/assets/`): `world-city3-collision.glb` (281 KB), `world-{glassq,foundry,terraces,halo}-collision.glb`
(131/84/135/187 KB), `world-links-collision.glb` (13 KB), `interiors/<id>.col.json` (77, ~115 KB total).

- Code: `collision.py` (`Col`: box/obox/prism/cyl/annulus/ground quads, `check_closed`, `quay`, `finish`; `bazaar()`, `hero_room()`), `col_interiors.py` (sidecars),
  district hooks inline in `glassq/foundry/terraces/halo/links.py` (`COL.*` next to the visual geometry so they stay in sync), `check_collision.py`
  (numpy, reads GLB + plan; run `python3 check_collision.py`), `colprev.py` (Workbench look; `COLJSON=id` adds furniture boxes), `colplan.py` (top-down room sheet).
- Rules: ground = flat quads at walk_z 0.2, NO ground over water (fountain basin ring, pools/ponds/canals are solid 0.7-0.9 m blocks); every plan footprint = closed prism;
  quay = 1.5 m wall, open only at bridge landings (|t|<10.5; Halo also at its 9 walkable piers); no roofs needed.
- Hero shops (77) are rooms: floor top +0.28 above walk_z (0.48 abs), facade with a 1.7 x 2.9 m door gap (T=0.3), side/back walls, ceiling at 4.2, upper floors one block, threshold + stoop; door leaf not in collision.
- Sidecar `[cx, cz, hx, hz, y0, y1, rotY]` in the layout's three space, plus `seats` and `floorY`. Boxes are trimmed so every seat approach point keeps 0.40 m clear
  and the 1.7 m x 3 m door path is free; a box covering an approach point fails the build. `index.json`/`heroes.json` rows gained `collision`. Press desk chairs now approach from behind.
- Not modelled: street furniture, umbrellas, awnings, Halo buttress blades, bridge arches, garden footbridges (canals are barriers), thin posts of pipe racks/halls.
- Rebuild: `blender -b --python build_city.py` (Bazaar + sidecars), each district script, `links.py -- N E W S`; then `python3 check_collision.py`.
