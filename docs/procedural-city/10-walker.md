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
- Software-GL frame rate is ~3 fps so walker dt is clamped to 0.1; the walker's CastFigure clamps its mixer dt the same way (gait path only),
  else on slow frames the clips ran ~3x ahead of the travel (feet sliding forward in screenshot sequences).

## Locomotion animation (2026-11-06, branch anim/walk-run)
- **View vs body heading.** `WalkerState.heading` is the VIEW (cameras, movement frame). `WalkerState.body` is what the figure faces:
  `stepBody()` (pure, called by `step`) turns it toward the wanted travel direction at `bodyTurnRate` 10 rad/s (third-person standard: D turns
  the body right and it walks forward to the right). Walking with travel > 120 deg off the view (hysteresis back at 100 deg) is a **backpedal**:
  the body faces away from travel, `backward` is set and Walk plays at negative timeScale (S = backpedal facing the view; S+A/D = backpedal at
  45 deg). **Running never backpedals**: Shift+S turns the body round to run toward the camera. Standing still the body re-faces the view.
  Ride camera and follow camera stay on the VIEW heading (the ridden body is hidden anyway).
- **AgentFrame.** CityWalker sets `f.heading = s.body`, `f.state = clipFor(speed)` ("idle" | "walk" | "run" at 0.15 / 1.6 m/s) and
  `f.gait = {reverse}`. `gait` is the opt-in: CastFigure's gait path only runs for frames that carry it, so the Agora crowd (bodyController /
  `f.body`, and the legacy Idle/Walk path) is untouched.
- **Blend (`gait.ts`, pure).** Idle -> moving = smoothstep(0.08..0.35 m/s); Walk -> Run = smoothstep(1.25 x walkSpeed .. 0.85 x runSpeed)
  = 1.35..2.27 m/s for Summer, so walker walk (1.3) is pure Walk and walker run (2.7) is pure Run. Weights ramp at FADE_S (0.25 s) on top.
  ONE phase: Walk plays at `cycleRate x duration` where cycleRate = speed / (Walk stride lerp Run stride by run mix); Run's clock is slaved to
  Walk's phase + `run.phaseOffset`, so a crossfade never mixes a left plant with a right swing. Rate clamp: >= 0.6x Walk, <= 1.5x Run.
  Resulting timeScales: Walk 1.204 at 1.3 m/s; Run 1.010 at 2.7 m/s.
- **Run facts (bodies.ts `BODY_SUMMER.run`).** Measured in three space from the shipped GLB (headless GLTFLoader + mixer, textures stripped):
  mean backward speed of toe + ankle joints while within 2 cm of their lowest point. Same method on Walk: 1.081 vs the bake's 1.0796 (0.1%).
  **Run 2.673 m/s = 1.960 m stride / 0.7333 s** (left foot 2.25-2.57, right 2.75-3.12: the clip is asymmetric). Run's stance toes ride
  **0.088 m above Walk's** (the bake stripped hips translation, so the run's stance drop is gone): CastFigure lowers the figure by
  0.088 x Run weight. Touchdowns (cycle phase) Walk L 0.375 / R 0.871, Run L 0.283 / R 0.846 -> `phaseOffset` -0.067.
- **Vertical guard / root-motion cancel.** In the current cast-summer.glb BOTH Walk and Run have a constant hips track (no bob, no ramp, no XZ
  travel: hips dy within +-1 mm over the cycle), so `verticalExcess`/HIPS_Y_BAND and the XZ cancel are no-ops for both (kept for other bodies).
- **Headless slip check (superseded 2026-11-07, `gait_slip.mjs`)**: mean |dz/dt| of foot JOINTS within 2 cm of their lowest. It hid
  two faults: it never ran the vertical guard, and joints near their own minimum are not feet on the floor (Summer's sole touched the floor
  in only 6 % of Walk frames). Use `harness/gait_full.mjs` (skinned vertices on the floor) instead.
- **Foot grounding + Remy fix (2026-11-07, `grounding.ts`, `harness/gait_full.mjs`, `harness/gait_probe.html`).** Three faults, measured
  on the shipped GLBs with the real CastFigure stack:
  1. **Air-walk.** No pose kept a sole on the floor: Summer's Walk floated 0.6-8.8 cm (contact 6 % of frames), Remy's 0-7 cm, Summer's
     Idle 1.3 cm up, Body Block's Idle 1.8 cm under. Fix: engine-style pelvis offset. Contact joints (Foot, ToeBase, Toe_End / KayKit
     `footl`, `toesl`) are read in the bind pose; each frame the figure is lowered by the lowest joint's rise over its bind height, on the
     live blended pose. Run's share uses the Run clip's own cycle minimum (sampled once at load; Summer 0.101, Remy 0.088, close to the
     old `footLift` 0.0967 / 0.082) so the flight phase stays airborne; capped at the live clearance so the Walk -> Run blend cannot sink
     (it sank 3 cm without the cap). Replaces the hips guard + `footLift` for every rig with contact joints; the sitting family keeps the
     guard, blended by the seated weight. Result: Walk contact 100 % of frames, lowest vertex within +-4 mm (Summer and Remy, fwd, back,
     circle r 1.5 m); Run contact frames at 0 +-5 mm, flight frames airborne.
  2. **Remy shoved metres sideways.** Mixamo FBX rigs keep centimetres under a scaled Armature (Remy 0.003). The root-motion cancel moved
     that node by the hips delta in armature units, i.e. up to 8 m per Walk cycle (vertex skate 11-27 m/s; filmstrip: 6 of 7 frames out of
     view). Fix: scale the delta by the parent's scale (`rootMotionDelta`). Agora's crowd Remy had the same bug.
  3. **Start/stop skate.** `cycleRateFor` floored Walk at 0.6x its own rate, so at 0.3 m/s the feet ran twice as fast as the body (sole
     skate 0.36 m/s). Floor now `MIN_WALK_RATE` 0.3 (skate 0.11).
  **Still sliding (foot-lock IK not done):** planted-sole skate with grounding on, `gait_full.mjs` (mean m/s): Summer walk 1.3 = 0.21
  (0.15 at 0.9: grows with playback rate, no zero-skate speed exists, so it is in the clip: heel-toe roll and the swing foot grazing the
  floor), blend 1.9 = 0.79 (worst frame 3.9: transient during acceleration), run 2.7 = 0.37; Remy walk 0.7 = 0.31, 1.3 = 0.71 (the
  walker's 1.3 m/s is 1.7x Remy's natural walk and inside his Walk -> Run band [0.96, 2.26], so he blends permanently; keep Remy off the
  walker or give the walker a per-body walk speed). The fix for the rest is foot locking: pin the planted foot in world space with a
  two-bone leg IK until lift-off (UE Foot Placement "plant" settings; three.js has CCDIKSolver in examples).

## The resting clip was a walk in place (2026-11-07, `bodies.ts` `clips.idle`, `tests/idle-clip.test.ts`)
Found while checking the grounding fix: the catalog's 2.7 s **"Idle" is not a rest pose**. Its ankles swing 0.1-0.6 m apart in a repeating step
(period 1.33 s, thigh +-36 deg Summer, +-27 deg Remy/Body Block; checked in three.js, in Blender (independent evaluator) and in a side-view
render), on every Mixamo body, and already in the pre-catalog GLBs (`bed5e3a^`). So a standing bot marched on the spot ("air-walk"), the
Idle -> Walk crossfade mixed two unrelated step cycles, and its loop popped (Summer seam 4.9 deg). The catalog's 9.9 s **"IdleLong"** is a real
stand (feet constant to 1 cm, thigh within ~5 deg, seam 0.2-0.5 deg, pelvis yaw mean 0.6 deg vs Idle 0.8 deg, so `TURN_YAW0` is unchanged).
- Fix: `CATALOG.idle = "IdleLong"` for every body. The clip tester's "Idle" button stays the REST button (`ClipTestState.fire("Idle")` clears the
  tester); the walking clip is no longer played by name.
- Measured with `harness/gait_full.mjs` (`IDLE=Idle|IdleLong`, planted-sole skate, mean m/s; figure bob in brackets): standing v=0 Summer
  0.88 -> 0.05 (6.5 -> 2.1 cm), Remy 0.77 -> 0.05; v=0.2 Summer 0.45 -> 0.12, Remy 0.32 -> 0.20; v=0.3 0.11 -> 0.06 / 0.16 -> 0.13; >= 0.5 m/s unchanged
  (idle weight is 0 there). Contact stays 100 % of frames, lowest vertex within +-4 mm.
- Regression test: for every body the resting clip's left thigh stays within 12 deg of its mean over the loop and the loop closes; negative
  control (idle = "Idle") fails on all six bodies (27-28 deg).
- Side effects: every idle agent in Agora now stands instead of marching; the KayKit bodies (no `Hips` node, so grounding does not apply to
  them) get the same clip swap. Software GL cannot show this in the console (one animation frame per screenshot); the filmstrips run the same
  CastFigure logic headlessly.

