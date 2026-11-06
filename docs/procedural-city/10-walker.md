# City 3 walkable bot (`?world=city3&walk=1`)

User-driven "summer" cast body with first-person (ride) and follow cameras. No crowd/navmesh in City 3, so a small kinematic controller.

- `walker.ts` — pure, three-free: `step(state, input, dt, world)`. Input is an abstract intent `{forward, strafe, turn, run, look?, faceHeading?}`;
  `moveToIntent()` builds one for an agent. `World` = `groundY(x,z,fromY)` + `blocked(from,to,radius)`. Step-up 0.4 m, water (< -0.5 or no ground) never entered.
- `bvhWorld.ts` — the `World` over the CameraCollider meshes (three-mesh-bvh): one downward ray from feet+0.45 (ignores decks above), wall fan at 0.55/1.0 m
  (above step-up so stairs are not walls), slide along walls.
- `CityWalker.tsx` — keys/mouse (pointer lock) -> intent -> step -> AgentFrame for `CastFigure` + ride/follow camera. CameraCollider stays wide-only.
  Camera `near` is 0.1 while walking (radius 0.4 - EYE_FORWARD 0.22 = 0.18 m eye-to-wall); restored on exit.
- Keys: WASD/arrows, Shift run, V ride/follow, click = capture mouse, Esc (or releasing the lock) = back to wide. `?walkDebug=1` exposes `window.__walk`.
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
- **Headless slip check** (figure translated at ground speed, the exact CastFigure blend; mean |world dz/dt| of foot joints within 2 cm of
  their lowest; the joint rolls through contact, so the floor is not 0): Walk at its natural 1.0796 m/s = 0.14-0.28 m/s (method floor);
  walk 1.3 = 0.16-0.27; blend 1.9 = 0.12-0.29; run 2.7 = 0.24-0.53 (right toe worst: asymmetric clip); backpedal 1.3 = 0.17-0.29.
  Old path at 2.7 (Walk capped at 1.4x) = 1.31 m/s. Planted-toe heights: Walk 0.028, Run (after the lift) 0.029-0.032.
