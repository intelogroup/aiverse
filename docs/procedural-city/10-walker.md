# City 3 walkable bot (`?world=city3&walk=1`)

User-driven "summer" cast body with first-person (ride) and follow cameras. No crowd/navmesh in City 3, so a small kinematic controller.

- `walker.ts` — pure, three-free: `step(state, input, dt, world)`. Input is an abstract intent `{forward, strafe, turn, run, look?, faceHeading?}`;
  `moveToIntent()` builds one for an agent. `World` = `groundY(x,z,fromY)` + `blocked(from,to,radius)`. Step-up 0.4 m, water (< -0.5 or no ground) never entered.
- `bvhWorld.ts` — the OLD `World` over the CameraCollider (visual) meshes: ray fan, honours `material.side`, so the back of any one-sided wall was passable
  and the fountain platform could swallow the bot. Now only the fallback if the collision GLB fails to load (and the camera collider's cousin).
- `capsuleWorld.ts` — the real `World` (same interface, walker.ts unchanged): vertical capsule (WALK_CONFIG.radius 0.4, 1.7 m, bottom sphere starts at feet+stepUp)
  vs the COLLISION meshes with three-mesh-bvh `shapecast` (official characterMovement pattern). Double-sided by construction, push-out is horizontal
  (`sqrt(r^2-sv^2)-sh`, floor/ceiling contacts left to groundY), `blocked()` sweeps from->to in substeps <= r/2 (running, dt 0.1 and a 3 m jump cannot tunnel,
  a zero-thickness one-sided quad is enough to stop it from both sides). `groundY` = highest UP-facing triangle at/below fromY (undersides ignored).
  `bakeCollisionRoot` bakes a GLB's `col_*` meshes (or all) into ONE world-space mesh + BVH; `boxesMesh` builds the interior furniture boxes (`noGround`).
- `walkColliders.ts` — the walker's collider list, SEPARATE from the camera's `colliderSets` (which stays visual-mesh, wide-only). Sets: `resident`
  (`world-city3-collision.glb`), one per streamed district (`collisionUrl` in `districts.json`, same frame as the visual GLB, dropped + BVH freed in `unload()`),
  `interior:<id>` boxes. `window.__districts.stats().collision` = {status, sets, meshes, triangles, loads, drops, buildMs}. Collision meshes are never in the scene.
- Interiors: `InteriorRoom` (GlbWorld.tsx) fetches `interiors/<layout>.col.json` (`{boxes:[[cx,cz,hx,hz,y0,y1,rotY]...]}`, three space, room `shift` applied) when the
  room streams in; one merged BVH; dropped with the room. Doors are NOT animated in this lane: the opening is free in collision (door gap), leaf is visual only.
- `CityWalker.tsx` — keys/mouse (pointer lock) -> intent -> step -> AgentFrame for `CastFigure` + ride/follow camera. CameraCollider stays wide-only.
  Camera `near` is 0.1 while walking (radius 0.4 - EYE_FORWARD 0.22 = 0.18 m eye-to-wall); restored on exit.
- Keys: WASD/arrows, Shift run, V ride/follow, click = capture mouse, Esc (or releasing the lock) = back to wide. `?walkDebug=1` exposes `window.__walk`.
- Known: strafe/back plays the forward Walk clip; run (2.7 m/s) skates (Walk clip caps at 1.4x); software-GL frame rate is ~3 fps so dt is clamped to 0.1.

## Testing the walker
- Unit: `capsuleWorld.test.ts` (closed boxes from outside/inside, corner, thin wall, high speed + dt 0.1, step-up 0.35 vs 0.6, stairs, platform edge, spawn not inside the
  fountain solid, hollow hero room with a door gap, interior boxes), `districts.test.ts` (collisionUrl plan), `interiors.test.ts` (col sidecar + registry).
- Browser fuzz: `harness/walk_fuzz.mjs` (`NODE_PATH=/opt/node22/lib/node_modules node docs/procedural-city/harness/walk_fuzz.mjs`, starts its own vite on a free port).
  Runs the REAL `step` + capsule world in the page via `window.__walk.script(inputs)` (fixed dt, no rendering, so 3 fps software GL does not matter; ~100 sim-s per wall-s),
  oracle `tools/city3/out/city3-nav.json` footprints. Debug hooks (`?walkDebug=1`): `__walk.put(x,y,z,h)`, `.script([[fwd,strafe,turn,run,dt]...]) -> [x,y,z,speed]*n`, `.worldKind()`.
- A fuzz with a synthetic collision GLB built from the same footprints proves nothing (circular): always run it against the exporter's real file.
