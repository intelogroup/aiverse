# City 3 walkable bot (`?world=city3&walk=1`)

User-driven "summer" cast body with first-person (ride) and follow cameras. No crowd/navmesh in City 3, so a small kinematic controller.

- `walker.ts` — pure, three-free: `step(state, input, dt, world)`. Input is an abstract intent `{forward, strafe, turn, run, look?, faceHeading?}`;
  `moveToIntent()` builds one for an agent. `World` = `groundY(x,z,fromY)` + `blocked(from,to,radius)`. Step-up 0.4 m, water (< -0.5 or no ground) never entered.
- `bvhWorld.ts` — the `World` over the CameraCollider meshes (three-mesh-bvh): one downward ray from feet+0.45 (ignores decks above), wall fan at 0.55/1.0 m
  (above step-up so stairs are not walls), slide along walls.
- `CityWalker.tsx` — keys/mouse (pointer lock) -> intent -> step -> AgentFrame for `CastFigure` + ride/follow camera. CameraCollider stays wide-only.
  Camera `near` is 0.1 while walking (radius 0.4 - EYE_FORWARD 0.22 = 0.18 m eye-to-wall); restored on exit.
- Keys: WASD/arrows, Shift run, V ride/follow, click = capture mouse, Esc (or releasing the lock) = back to wide. `?walkDebug=1` exposes `window.__walk`.
- Known: strafe/back plays the forward Walk clip; run (2.7 m/s) skates (Walk clip caps at 1.4x); software-GL frame rate is ~3 fps so dt is clamped to 0.1.
