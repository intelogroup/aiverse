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

## Contact-pose / foot-rig / skating audit (2026-11-07, `harness/contact_probe.mjs` + `contact_probe.html`)
Why the planted foot still slides after grounding, measured on the shipped GLBs (lowest skinned foot vertex = the rolling contact point, in
the in-place body frame; a planted foot must move back at constant speed, so `z + v t` must be flat; live pelvis offset as the walker applies).
- **Rig.** All bodies share the Mixamo chain UpLeg > Leg > Foot > ToeBase > Toe_End; no heel/ball/IK bones in the GLBs, the heel is the shoe
  geometry. Proportions differ a lot: Body Block (source of every clip) leg 0.522 m (0.39 of height), ankle 12.5 cm high, foot 17 cm, flat
  "plate" feet; Summer leg 0.691 m (0.545), ankle 6.8 cm, wedge sandals; Remy 0.587 m (0.451), ankle 8.5 cm. Clips are retargeted by joint
  ROTATION only (`bake_remy.py` rest-delta), so foot height, stride and hip height do not carry over: Summer's legs are 32 % longer than
  the clips' author's, hence the floating/sinking the pelvis offset now hides.
- **Walk contact pose.** Heel strike (toe pitched +47 deg Summer, +37 Remy), flat by mid-stance, then the foot leaves flat (pitch ~0 deg at
  lift-off, no heel rise/toe-off roll before it; toe-off plantarflexion happens in the air). Stance 53-60 % of the cycle per foot,
  symmetric. Stance speed L/R: Summer 1.14/1.11 m/s (bodies.ts 1.107: playback is right), Remy 0.82/0.80 (bodies.ts 0.77: 5 % low).
  Remaining skate = the contact point's path is not straight: residual RMS 1.3-1.7 cm (Summer), 1.9-2.5 cm (Remy), peaks 4.5-5.4 cm at
  the end of stance (flat lift-off).
- **Run contact pose is asymmetric** (inherited from Body Block's Run: stance L 58 % / R 45 %, Summer 56/48, Remy 57/46). Stance speed L/R:
  Summer 2.16/2.74 m/s, Remy 1.73/2.44 (Body Block 1.51/2.25; its plate feet make it unreliable). No single ground speed fits both feet:
  at the walker's 2.7 m/s Summer's left foot skates ~0.5 m/s, Remy's left ~1 m/s (matches the measured 0.37 / 0.77-0.93 means).
  bodies.ts `run.speed` (Summer 2.7755, Remy 2.66) sits near the right foot only.
- **Swing clearance** mid-swing is 1.6-1.7 cm (Walk, both bodies), inside normal human minimum toe clearance (1-2 cm): not a defect, but it
  reads as toe drag.
- **Consequences for the fix** (research: Kovar, Schreiner, Gleicher 2002 + ozz-animation Foot IK): equalise/handle per-foot stance
  speed (retime the Run so both stances last the same, then IK for the residual stride-length difference); lock each foot's world position
  during stance, take the knee pole from the original knee direction, soften near full extension, blend the correction over a window
  around constraint on/off (Kovar: 5-10 frames, cubic ease alpha(t) = 2t^3-3t^2+1; max leg stretch they needed 2.6 %); plant intervals are
  supplied, not detected, in both references (here: lowest-vertex height < 1.5 cm after the pelvis offset, measured by this probe).
- Caveat: the 1.5 cm contact threshold and the live pelvis offset are my choices; the "fixed floor" columns of the probe (one offset per
  cycle) show how little of the Walk touches an unmoving floor (13-18 %), i.e. the pelvis really must move with the stance foot.

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


## Runtime foot lock (2026-11-07, `footLock.ts`, branch `anim/footlock-ik`; `?footlock=0` / `window.__footlock(false)` switches it off)
Why: after grounding the planted sole still skated (Summer walk 0.2 m/s, run 0.37; Remy walk 0.7, run ~1). Recipe = Kovar-Schreiner-Gleicher 2002
+ ozz-animation foot IK, adapted to a mixer-driven rig (CCDIKSolver rejected: no pole vector, MMD-oriented, demo has no AnimationMixer).
Per leg, each frame, after the mixer, root-motion cancel and grounding (only on the walker's gait path; sit/tester/turn clips never reach it):
1. **Landmarks**: heel (rearmost low sole vertex, read from the bind data), ball and toe tip (contact joints), plus the toe-tip vertex.
   One is **pinned** at its world XZ while it is within 1 cm of the floor (after the grounding drop) and not moving forward past the body
   (lift-off, > 0.5 x body travel); it lets go above 3 cm. The foot is translated by the mean offset of its pinned landmarks.
   Pinning the ankle was tried first and was worse at heel strike / toe-off (the sole pivots about a fixed ankle): 0.14 vs 0.06 m/s walking.
2. **Two-bone IK** (law of cosines) with the knee on the clip's own side (pole = the original knee direction), the foot keeps its world
   orientation, blend in 0.04 s / out 0.1 s with the cubic ease alpha(t) = 2t^3 - 3t^2 + 1.
3. **Pelvis dip**: the baked legs run at 0.98-0.999 of full extension through the whole stance (Summer's legs on Body Block's clips), so a
   foot held in place needs slack: the pelvis dips (smoothed, <= 6 cm, 1-4 cm typical) until each locked foot is inside 98 % reach, and every
   leg is re-aimed at its world target so the dip bends knees instead of sinking feet. A lock that needs more lets go.
4. **Swing clearance**: an unpinned foot keeps its lowest landmark >= 1.5 cm (the baked toes graze the floor mid-swing; Remy's Walk at 1.41x
   scraped it at 5 m/s).
Cost: 0.017 ms/frame Summer, 0.025 ms Remy (node, one figure; the heel search runs once, lazily, on the first gait frame).

Measured (`harness/gait_full.mjs`, planted-sole skate of skinned vertices < 1 cm, mean m/s; A = grounding only (main), C = + foot lock):
| speed | Summer A -> C | Remy A -> C |
|---|---|---|
| walk 0.3 | 0.057 -> 0.012 | 0.128 -> 0.018 |
| walk 0.7 | 0.108 -> 0.028 | 0.306 -> 0.062 |
| walk 1.3 (Remy: blend 0.17) | 0.205 -> 0.058 | 0.713 -> 0.088 |
| blend 1.9 | 0.785 -> 0.202 (contact 96 -> 80 %, floats to 4.7 cm) | 0.533 -> 0.095 |
| run 2.7 | 0.368 -> 0.158 | 0.366 -> 0.182 |
| backpedal 1.3 | 0.204 -> 0.054 | 0.553 -> 0.154 |
| circle r 1.5 | 0.233 -> 0.066 | 0.745 -> 0.099 |
Lowest vertex stays within -4..+7 mm (sole never sinks). `footprint_trace.png` (world Z of each foot's floor vertices: flat steps = planted)
shows Remy's four sliding ramps per 3 s gone. Filmstrips (`gait_probe.html?...&ik=1`) show no knee flip or stretched leg.
Not fixed: the Walk -> Run blend (1.6-2.4 m/s), where the clip's stance feet disagree with the travel by up to 22 cm (the lock then asks for
more than the pelvis can give, lets go, and the foot floats up to 4.7 cm for 4 % of the cycle; capping the correction at 12 cm was worse:
17 % airborne); Run's left/right stance asymmetry (still 0.16-0.18 m/s). Both live in the clips: the bake-time fix (equalise the Run's two
stances, re-measure `bodies.ts`) is the next step if they matter. Real-console motion cannot be seen under software GL (one frame per screenshot).

### Standing hold (2026-11-07, `footLock.ts`, branch `anim/stance-hold`)
Report: "standing idle, the feet skate left-right". Two causes, both measured headlessly (`gait_full.mjs`, VS=0; a `ROT` rad/s variant turns the group):
the IdleLong sway moves the soles ~1 cm (0.05 m/s), and the walker turns the BODY toward the view heading on the spot (`stepBody`, up to 10 rad/s)
as one rigid piece, so the soles sweep sideways (Summer 0.10 m/s at 1 rad/s, 0.21 at 2.2, 0.56 at 6). The lock only ran above 0.25 m/s.
Fix: below that speed every foot on the floor is held, position AND heading (no velocity test: the pins are taken where the feet stand; the foot's world
orientation is kept, up to `MAX_HOLD_YAW` 0.6 rad from where the clip points it, past that the foot follows the body round). Moving off keeps the pins
as ordinary stance pins, and stopping pins the feet where they are instead of sliding into the idle pose.
Standing still, planted-sole skate (m/s): Summer 0.052 -> 0.001, Remy 0.046 -> 0.001. Turning on the spot (continuous, so past the yaw limit most of the
time): 1 rad/s 0.104 -> 0.020 (Summer) / 0.126 -> 0.030 (Remy); 2.2 rad/s 0.210 -> 0.045 / 0.257 -> 0.117; 6 rad/s 0.561 -> 0.122 / 0.686 -> 0.237.
Walk/run numbers unchanged. Not done: stepping the feet for turns past ~35 degrees (the catalog TurnLeft90/TurnRight90 clips that Agora's body
controller uses would be the source); a long continuous turn still pivots the soles at the limit.

### Turn stepping (2026-11-07, `footLock.ts` `STEP_*`)
Standing, a held foot that the body has left behind by more than `STEP_DIST` 0.10 m, or turned more than `STEP_YAW` 0.35 rad (20 deg) from the clip's
heading, steps back under the body: over `STEP_S` 0.28 s its offset and held heading ease to the clip's, with a `STEP_LIFT` 5 cm sine arc; one foot at
a time (turning continuously the feet alternate, as a person does). The 0.6 rad yaw clamp now only applies when a step cannot keep up (very fast turns).
Measured (`harness/gait_full.mjs` with `ROT=` rad/s and `VS=0`, planted-sole skate m/s, standing hold -> + stepping):
| turn rate | Summer | Remy |
|---|---|---|
| 1 rad/s | 0.020 -> 0.008 | 0.030 -> 0.011 |
| 2.2 rad/s (arrow keys) | 0.045 -> 0.019 | 0.117 -> 0.030 |
| 6 rad/s | 0.122 -> 0.102 | 0.237 -> 0.198 |
Walk/run numbers unchanged. Remy's support foot sits 1.0-1.4 cm up while the other steps: that is his IdleLong pose (weight on the right, left foot
relaxed 1 cm off the floor), not the lock; the harness's 1 cm "contact" metric reads 73-78 % for it.
Not done: the Walk -> Run blend band (1.6-2.4 m/s) is crossed in ~0.1 s with the walker's accel 14/s, so it is not worth a bake today; Run's left/right
stance asymmetry (0.16-0.18 m/s residual) still needs the bake-time fix.
Also: React StrictMode (dev) mounts, cleans up (`stopAllAction`) and mounts again, which stopped the Idle the actions memo had started, so a DEV figure
stood frozen in its first pose (production was fine). The mount effect now restarts Idle.

## Doors: who opens them (2026-11-07, `teaDoor.ts`)
Only the Matchmaker's Tea House has a real door (leaf, knob, OpenDoorInwards/Outwards performance); the other 76 shops are open gaps.
Any walker drives it: walking forward at the shut door (within 1.8 m of its plane, 0.9 m of its centre line, facing it) starts the full
performance: align at the stand pose (fine-align in the pose frame inside 0.6 m), the clip, the step-through, auto-close once nobody is in the
doorway. Actors: the player (`CityWalker`, the walk HUD's clip override) and Scout (`?agent=1`, its own clip tester); NPCs plug in with an id and
`clipChannel(clips)`. One session at a time: anyone else near the door waits outside until it is open, then walks through.
Live check (software GL): Scout fountain -> stall-0 -> tea door point -> `go_to` a point inside: align, perform, door 95 deg, step-through, `arrived`
inside at y 0.48, door closed behind it. Debug: `window.__walk.door()` (walk mode), `window.__scout.door()` (agent mode).

## Sound: consent gate + voice emitter (2026-11-07)
`soundDirector.ts` no longer arms on the first gesture. It starts `consent: "unknown"`; the walk HUD shows "Hear the verse on this device? Enable sound / No thanks"
and the click is the gesture that creates and resumes the AudioContext (the iOS rule). `arm()` is a no-op until `grantConsent()`; a decline is final for the
session. New positional **voice emitter** (`playVoiceBuffer` / `playVoicePcm`): its own gain chain into master, gain = `VOICE_GAIN * emitterGain(distance)` recomputed
every tick (the same law as the Mage's stall music), not PA-ducked, with its own analyser (`snapshot().voice`). Nothing speaks yet: the speech engine and
the Mage-Summer greeting stay in PR #37 until they are split out. Known cosmetic: with the consent ask showing, the HUD grows and overlaps the centre hint pill at
900 px wide. Tests: `soundDirector.test.ts` (consent), `soundLogic.test.ts` (emitter law).

## Interactables: the Tea House radio (2026-11-07, `interactables.ts`, `interactableMesh.ts`; branch `feat/tea-radio`)
A usable prop is NOT an instanced layout prop (instances have no identity). `tools/city3` records it (`kit.add_interactable`, called from `rooms.py`) and lists it in
`out/interiors/index.json` as `interactables[]` on the room: `{id, room, kind, asset, label, pos, rotY, stand, heading, floorY, pilot}`. The definition is static data,
known before the room streams in, so Scout can plan against it and the sound layer plays a radio nobody is looking at; only the MESH is tied to the room's streaming
(`InteriorRoom` clones the library asset as plain Meshes sharing the library's geometry/material, plus a pilot light of its own, and disposes only that).
- **Controller** (`InteractController`, pure): `register(defs)`, `request(id, actor, channel, at?)`, `requestNearest`, `drive(s, dt, actor)` -> `WalkInput | null`, `tick(dt)`,
  `subscribe`, `isOn`, `status(actor)`. A session is align (walk to the stand pose, face the prop; `alignInput` from the door machine) -> perform (the `Interact` clip; the
  state flips at `INTERACT_CONTACT_S` = 1.5 s) -> done. One session per prop, an actor owns at most one, actors expire 1 s after their last sighting. Clip channel = any
  `{fire, current}` (`ClipTestState`, `WalkClipOverride`).
- **Measured** (`Interact` clip, Summer and Remy, hand bone vs hips): the right hand is at full extension from 1.2 s to ~1.9 s, retracted by 2.6 s; it reaches only ~0.17 m
  past the hips (~0.27 m with the palm). Flip at 1.5 s = mid-hold.
- **Player**: stand within 2 m of the stand point, the HUD line shows `E · turn radio on/off`, E starts a session (`CityWalker`). `window.__walk.interact()` for headless checks.
- **Scout**: `{type:"interact", target}` (prop id, kind or label) walks to the stand point (door hook still applies), then hands the body to the controller; the action's clocks
  pause while it holds. Outcome `done` with `detail: "on" | "off"`. `oracleScene` lists props as `kind:"interactable"` with `state`. `window.__scout.interact()` for headless checks.
- **Sound**: `SoundFrame.emitters` (`{id,x,z,on}`) -> one gain chain per emitter in the director, looping `RADIO_CLIP` (test audio: the stall music) at `MUSIC_GAIN *
  switchedEmitterGain(on, distance)`, faded, PA-ducked. Live (SwiftShader): beside the radio gain 0.17, ~10 m 0.04, ~20 m 0.
- **Geometry lessons**: the walker body is 0.4 m (`WALK_CONFIG.radius`), so a stand point must be >= 0.45 m off furniture boxes (`check_collision.py` checks it for interactable
  stands); the Tea House table is 0.46 m, so the closest stand is x = -16.95 and the radio sits at the table's near edge with its panel ~6 cm past it. The hand still stops
  ~0.2 m short of the panel: a hand IK (the analytic two-bone solver already in `footLock.ts`) onto `pilot` during perform is the follow-up. The pilot light position is AUTHORED
  (`def.pilot`, prop-local); the largest-part fallback picked the antenna tip on this asset (the antenna/mic mesh is the biggest part).
- **Not rebuilt here**: the full Blender rebuild needs gitignored inputs this environment lacks (3DTextures Water_002, stale `tex_m`), so the committed `index.json` /
  `heroes.json` were patched by values derived from the same placement. On a machine with the inputs: `blender -b --python build_city.py`, then `git diff` the two files and the
  copies in `apps/console/public/assets/interiors/`; they must be identical (the library GLB and all layouts are unchanged: the radio asset is already in the library).
- Tests: `interactables.test.ts` (12), `interactableMesh.test.ts` (6), `scout.test.ts` (interact + oracle), `soundLogic.test.ts` (switched emitter),
  `tests/interactables-assets.test.ts` (the shipped definition against the real furniture collision: reachable from three sides).

## Speech that never waits, gestures that follow the voice (2026-11-07, branch `feat/tts-warm`)
- **Warm on consent** (changed 2026-11-07 at Jim's word; was "on entering City 3"). The "Enable sound" click starts `warmPhonon()`: the Phonon engine loads (64.5 MB from the pinned Hugging Face
  revision or `VITE_PHONON_MODEL_URL`) and the scripted greeting is pre-synthesized into a PCM cache; the engine then stays loaded for the
  page. Nobody who declines sound downloads the 64.5 MB model; live: 0 requests to Hugging Face before the click, warm 16 s after it.
- **Never wait.** `prepare()` order: cached PCM -> live synth (only once the engine is loaded) -> the pre-rendered clip of the same voice.
  Before this, the first greeting waited on the model download (~12 s here), the Mage gestured in silence and the visitor walked off.
  Live: warm = first line 1 ms after the trigger, all 4 lines from the cache; model unreachable = clips, first line 59 ms after the trigger.
- **Gesture follows voice.** The Mage waves when someone walks up (`keeperGesture`, keeper.ts) and plays `Talking` only while his line plays
  (`setMageTalking` -> `mageVoiceRef` -> BazaarLife). Same for Summer. A line that cannot be made gets no gesture. The patrol (no speech)
  now gets a wave, not a silent Talking loop.
- **Fixed on the way:** the greeting was bound to the sound director it was built with; React StrictMode's unmount effect disposes and
  re-creates the director, so the greeting kept asking a dead director for consent and never spoke. It is rebuilt when the director changes.
- Debug (`?ttsDebug=1`): `window.__tts.warmth()` -> `{ready, cached, warming}`; `log()`, `status()`, `start()` read the live greeting.
- Tests: `plazaSpeech.test.ts` (never-wait order, gesture follows voice), `keeper.test.ts` (`keeperGesture`).

## The Tea House bartender (2026-11-07, `bartender.ts`, `TeaBartender.tsx`; branch `feat/bartender`)
Remy stands behind the bar (x -29.5, z -82.69: the middle of the 1.53 m corridor between counter and bottle shelves, middle of the 12 m bar),
on a 0.35 m duckboard hidden by the counter, voice "Hugh". Whoever reaches the bar (the zone in front of the whole counter run, 3 m deep, or
within 3.2 m of him; leaving needs the zone + 1 m / 4.2 m) gets a turn toward them, a wave, and a greeting: "Welcome to the Matchmaker's
Tea House..." first, "Back again? ..." for a returning visitor, never the same visitor twice within 45 s. He TALKS only while the line plays
(`keeperGesture`); the line comes from the warm cache, else live synth, else the pre-rendered clip. Visitors: the player's bot and Scout
(`ScoutAgent positionRef`). Body + board are one walker collider (`npc:bartender`). Debug: `window.__bartender.info()` (walkDebug / agent /
ttsDebug). Live: player at the bar -> greeted 15 ms after the trigger from the cache, Talking only while speaking; Scout (agent mode, no sound
consent) -> turned + waved, line logged `silent`.
- **Scale note (not fixed):** the cast is ~1.30-1.45 m tall (KayKit bodies and Remy normalised to 1.30 m, Summer ~1.45 m) while the hero
  rooms are real-size (counter 1.12 m, tables 0.78 m, door knob 0.80 m). On the floor only the bartender's head cleared the counter. The
  duckboard hides it here; a city-wide decision (scale the cast to ~1.75 m, or the rooms down) is open.
- Tests: `bartender.test.ts` (trigger zone, facing, cooldown, returning visitor, hysteresis), `tests/bartender-placement.test.ts`
  (the spot and collider against the shipped `tea.col.json`).

## Realistic cast heights (2026-11-08, branch `feat/cast-scale`)
Every cast GLB ships at the old ~1.3 m standard (Body Block's; the KayKit bodies were shrunk to it on 2026-11-05). Measured on the shipped GLBs
(IdleLong frame 0): Body Block 1.340, Summer 1.254 with her hat (head top ~1.225), Remy 1.283, Mage 1.306, Barbarian/Knight 1.293, Skeleton
Warrior 1.30 + horns. The rooms are real-size (counter 1.12 m, chairs 0.46, benches 0.45). Jim: "the KayKits are too short, we should not
normalize to them"; chosen targets: Remy 1.78, Summer 1.68, Body Block 1.75, KayKit 1.70 to the tip.
- **How:** no re-bake. `bodyAtScale(scale, raw)` (bodies.ts) gives each body a display scale (1.302-1.387) and scales its registry facts with it
  (hipsY, walkSpeed, run.speed, run.footLift; phaseOffset is a ratio and stays). CastFigure scales the cloned figure; grounding.ts measures in
  the scene's own frame, so its offset is multiplied by the scale where it is applied. Foot lock, head camera, labels read world space.
- **Knock-ons:** walker run 2.7 -> 3.6 m/s (a 1.68 m Summer's natural Run is 3.8 m/s; 2.7 sat mid-blend); camera rig lengths x SCALE_SUMMER
  (framing unchanged, eye 1.58 m); tea door knob 0.80 -> 1.10 m above the plinth and the grasp offsets x SCALE_SUMMER (the 1.10 m knob sits in
  the glass pane, as the 0.80 m one did just above the panel); bartender duckboard removed (Remy shows from the waist up over the counter).
- **Live (software GL):** full tea door performance completes (align -> perform -> travel -> open, inside at y 0.48); Shift run = pure Run at
  3.59 m/s; bar shot with Summer and the bartender; Agora crowd proportions vs benches/trees (A/B against main: the bench no longer reaches her
  chest). The Agora embody `sit_on` did not complete within 3 min in this harness on main either (not caused by the scale; open).
- Not measured: foot-lock skate numbers at the new scale (`gait_full.mjs` does not apply the display scale yet).

## `packages/world-sim`: the pure half of the walker (2026-11-10, branch `feat/world-sim`)
The server-side agent sim needs the same walker, collision, navigation, scout executor and door/prop controllers the console runs, without a browser. They now live in
`packages/world-sim/src` (17 modules: actors, bodies, bodyController, capsuleWorld, clips, embody, gait, interactables, keeper, navigation, scout, teaBuilding, teaDoor,
teaElevator, walkColliders, walkOverride, walker, + `locomotionState`). The console keeps a ONE-LINE shim at each old path (`export * from "@aiverse/world-sim/<name>"`), so its
64 importing files and their tests are unchanged; the tests still live in `apps/console/src/features/world/` and run there.
- **Purity guard**: `apps/console/tests/world-sim-purity.test.ts` fails if a package module imports anything but the package, `three` or `three-mesh-bvh`, uses a browser global
  (`window`, `document`, `localStorage`, `AudioContext`, `requestAnimationFrame`, ...) or loses its shim. `locomotion.ts` stays in the console (Recast WASM); only its
  `LocomotionState` type moved (`locomotionState.ts`), `locomotion.ts` re-exports it.
- **One three**: the package and the console must resolve the SAME `three` (same version spec); a second copy breaks `instanceof` between meshes. Checked: both `readlink -f` to one store dir.
- **Lesson**: my first dependency audit only matched double-quoted imports and missed `teaElevator -> './teaBuilding'` (single quotes); `tsc -b` caught it. Audit with both quote styles, or just let tsc and the guard test find it.
- **Measured headless (Bun 1.4.4, 4-core sandbox)**: collision GLBs load + BVH 163 ms (87k tris); a walker step is about 42-45 us (500 agents = 62-65% of one core at 10 Hz); `planRoute` is
  98-528 ms for a reachable goal and 7.8-17.9 s for an unreachable one (it exhausts its 10,000 expansions), so planning must never run on a tick thread.

### Headless agent body on a navmesh (2026-11-10, branch `feat/world-sim-body`)
`AgentBody` (one agent: `WalkerState` + `ScoutExecutor` + `ClipTestState`, the part of `ScoutAgent.tsx` that is not React) and `VerseSim` (the world: collision sets, the shared
Tea House door and prop controllers, every body, 1/30 s substeps) are in `packages/world-sim/src`; `node/loadWorld.ts` reads the shipped City 3 data from disk. Test:
`apps/console/tests/verse-sim.test.ts` (node env, 2.5 s). A new body spawns at (5.68, 0.20, 10.57), exactly where the browser scout spawns.
- **Planner: Detour navmesh, not the grid A\*** (`cityNav.ts`, taken from PR #75; its scout/separation/console wiring were not taken). Same `go_to` to 32 places: grid A\* arrived
  20/32, worst single tick 55.6 s, 690 s wall; Detour 32/32, worst tick 14 ms, 3 s wall. All 158 places: 157 reachable. The mesh is baked by `node/bakeNavmesh.ts`
  from the sim's own collision sets (Bazaar + districts + hero-room furniture boxes, without the closed-door blocker) into `packages/world-sim/data/` (8.5 MB, ~2.6 MB compressed);
  the test fails if `world-city3-collision.glb` changes without a rebake.
- **Lesson, climb limit**: PR #75's bake (maxClimb 0.4 at 0.2 m cells) read a 0.5 m curb as climbable (Recast rounds the climb up) while the walker's step-up is 0.4, so bodies stalled
  at it (149/158 places). Bake with maxClimb 0.31 at 0.1 m cells and erosion = the walker's radius 0.4.
- **Lesson, same world**: a mesh baked from the Bazaar collision alone routed bodies through Tea House booths and tables (interior furniture boxes are separate collision sets), and
  a run passed or failed on float noise (Bun vs Node). Bake from every set the walker collides with, then the sequence passes under both runtimes.
- **Bun vs Node**: the 8-step Tea House sequence (stall, door, sit, stand, radio on/off, exit) ends within 0.75 m of the Bun goldens under vitest/Node. Browser parity is only anchored
  on the first step (browser ended it at (-16.59, 14.88), headless at (-16.49, 15.13)): the browser run of the Tea House step did not finish in 9 min of software-rendered wall time
  (`harness/verse_parity.cjs`), so later steps are headless regression goldens.
- **Known gaps**: avoidance has no occlusion test (a body may yield to a mover behind a wall); no elevator controller (upper floors); `hall-0` was unreachable until 2026-11-11 (its stand sat on the hall's wall line; moved 2.5 m off to `[34.5, -74.0]` in `city3-places.json`, all 158 places now reachable; the hall is still doorless);
  the navmesh does not model the Tea House door (the door machine opens the blocker on the way).


### Server sim service + `/world` API (M4, 2026-11-10, branch `feat/sim-service`)
A remote agent gets a body that lives on the server: `apps/sim` (own Bun process, private port) holds `VerseSim`; the **gateway is the only public edge** (`routes/world.ts`, behind
`agentAuth`). The sim never sees an agent token: the gateway forwards `{agentId, visitId, expiresAtMs}` with a shared secret and the header `x-sim-api: 1`.
- **Enable**: `AIVERSE_WORLD_MODE=1` + `SIM_URL` + `SIM_INTERNAL_SECRET` (>= 32 chars, same value on both sides, never logged or put in docs/cards). Sim only: `SIM_PORT`, `SIM_HOST`,
  `SIM_ASSETS_DIR`, `SIM_MAX_BODIES` (default 200). The agent card advertises `x-aiverse-world` only when both flags are set. The 8.5 MB navmesh bin ships with the sim image.
- **Routes** (all need an ACTIVE visit, else 403 `no_visit`): `POST /world/body`, `DELETE /world/body`, `POST /world/act {id, action}` -> 202 `{act:{state:"running"}}`,
  `GET /world/act/:id` (poll until `settled`, has `outcome`), `GET /world/observe` (body snapshot, nearest place, room, `oracleScene`, last act), `GET /world/map` (places).
  Only `act` is a non-GET, so only `act` spends the visit's `maxActions`; polls and observe are free.
- **Action contract**: `validAction`/`ActionLedger` live in `packages/world-sim/src/actionProtocol.ts` (`tools/embodied/protocol.ts` re-exports). Same id + same action = same record
  (idempotent); same id + different action = 409 `id_conflict`; one action in flight per body (`rejected/busy`); `stop` cancels; no teleport, no `say`.
- **Limits**: act 2/s, reads 5/s per agent (token bucket, burst 2x); body 4 KB; 200 bodies per process; sim-time lease 30 s without a touch stops a busy body.
- **Lifecycle**: `forceDisconnectAgent` (pause, kill, key rotation, delete, visit end) calls `notifyAgentGone` -> `DELETE /bodies/:id` on the sim (mutation-tested: removing the hook fails
  the pause test). The sim also expires each body at `expiresAtMs` as a second line.
- **Failure modes**: sim down/slow -> 503 `world_unavailable` after 2 s (no gateway worker hangs); wrong secret or version -> 502; **sim restart loses all bodies** until M6 persistence
  (agent sees `no_body`, re-attaches).
- **Tests**: `apps/gateway/src/routes/world.test.ts` (real gateway app + Postgres/Redis + HTTP to a real sim on the real City 3 world: attach, `go_to` Tea House door arrived within 1.5 m,
  replay, conflict, visit stop, pause, no visit, dead sim, wrong secret), `apps/sim/src/server.test.ts`, `apps/console/tests/world-service.test.ts`.
- **Not done**: `look` (depth/class ray map, M4b); sensorium-guard coverage of `/world`; viewer stream (M5); persistence/budgets/natives (M6). No deploy config touched.
