# Animation: body controller and turn clips

## Design (apps/console/src/features/world/bodyController.ts)
Three loops: **mind** (LLM, seconds, costs credits, sparse intents) → **reflex/body** (this file: local, per frame, O(1), no model) → **animation** (mixer weights).
1000 bodies × 60 frames = 11.7 ms (≈1% of one core-second): "realtime" costs CPU, not credits.
- Heading chases the direction of travel at ≤200°/s (was: `rotation.y = atan2(vx, vz)` snapping, up to 180° in one frame).
- Speed throttle by heading error: full ≤30°, 0.25 floor, halt ≥110° (`crowd.setSpeedScale` → `agent.updateParameters({maxSpeed})`, only when the scale moves ≥0.03).
- From standstill, error ≥70° plays `TurnLeft90`/`TurnRight90` (two for >135°); urgency 1.4 (feet stay planted at any rate).
- Idle↔Walk weight = smoothstep(speed 0.1..0.4); Walk timeScale clamp 0.85–1.3 (no slow-mo below).
- `?body=legacy` restores the old pipeline; `?bodyDebug=1` logs per-frame headings to `window.__bodyLog`.

## Facts measured about the cast rig (cast-bodyblock.glb) — three-space, from the two UpLeg joints
- TurnLeft90: +90.26°, 1.8667 s. TurnRight90: −90.46°, 1.6333 s. Curves are monotone with a ~15% lead-in; tables in `bodyController.ts`.
- **Both turn clips start at −58.7° absolute pelvis yaw; Idle sits at +3.4°** → a constant start offset `TURN_YAW0 = −62.1°`. Cancel `baked = TURN_YAW0 + yaw`, not just `yaw`.
- Walk/Idle pelvis sway ±8–9°; Walk hips travel ≈0 horizontally (root-motion extraction already handles the little there is).
- Skeleton: `Scene > BODY (quat 0.707,0,0,0.707, scale 0.0067) > mixamorig_Hips`. The parent `BODY` is what the figure rotates/translates (`rootMotion.parent`).
- A paused `AnimationAction` is scrubbed with `action.time = t * duration` before `mixer.update`; weights/blends still apply.

## How the figure applies it (CastFigure.tsx)
`group.rotation.y = heading` (controller) and `skeletonRoot.quaternion = Rot_Y(−baked·turnWeight) · restQuat`, with idle/walk weights × (1 − turnWeight).
Visible yaw = start + clip swing, so the clip's own stepping is intact. **Proof:** controller world feet = original clip feet rotated rigidly by 62° (fit 62.0 vs expected 62.1), max error 0.6 mm; pelvis tracks heading within sway (7°).

## Measured (real Detour crowd, 3 seeds, 'go back 5 m' order)
Heading rate 1962–10800 → ≤217 deg/s; pops (>20°/frame) 1–3 → 0; walking again 1.4–2.6 s after the order; foot-slide proxy 0.72 → 0.37 m (crude).

## Known gaps
No 180° clip (2×90° ≈ 2.6 s at urgency 1.4); no walk start/stop clips; no head look-at (reflex layer = rules, not built); `embody.ts` refuses a second
skill as "busy" (no preemption); Embody's own `face` turn (π rad/s) feeds the crowd heading gradually so small turns never trigger the clip.
City 3 has no crowd. KayKit bodies untested with turn clips (rootMotion lookup by `Hips` suffix is assumed).
