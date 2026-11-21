# Intersection signals (Bazaar)
Status 2026-11-20: 24 junctions x 4 corner posts, 3-lamp heads, fixed-time cycle. Not baked into `world-city3.glb`.

- Generator: `python3 tools/city3/signals.py` (pure python glTF writer, needs `tools/city3/plan.json` from `plan.py`) -> `apps/console/public/assets/world-signals.glb` (352 KB, committed). Junctions = street crossings outside the plaza (`plan.json` streets), same rule as `build_city.py` `INTS`.
- Layout: post 0.8 m beyond the junction corner on both axes, head 3.7-4.7 m up, head faces its own approach (right-hand traffic, far right corner): eastbound SE corner, westbound NW, northbound NE, southbound SW. Lamps stand 4 cm proud of the head (>= 3 cm z-fight rule).
- Lamps are separate meshes with materials `sig_<ns|ew>_<red|yellow|green>`; the runtime only sets `emissiveIntensity` (0.9 on, 0.04 off) when the phase changes.
- Runtime: `IntersectionSignals.tsx` (mounted in `DistrictWorld.tsx` beside `BazaarCar`), plan in `signalCycle.ts` (12 s green, 3 s yellow, 1.5 s all-red, per direction pair; test: never green to both). All junctions run the same clock.
- Verified by screenshot in a plain three.js page (overview, eye level, eastbound approach): heads face their approach, lit lamp reads correctly. Not yet checked inside the live console.
- Open: posts have no collision (a walker passes through them); no pedestrian signals; no per-junction offsets; the driving lab's light does not read this clock yet; vertical signs and lane/stop-line paint still to do.

## Road paint and signs (roadmarks.py)
- Generator: `python3 tools/city3/roadmarks.py` (reads `plan.json`) -> `apps/console/public/assets/world-roadmarks.glb` (~380 KB, committed), loaded by `RoadMarks.tsx`.
- Paint at `walk_z + 0.05` like the zebra stripes: edge lines, double solid yellow + white lane dividers on the 20 m avenue, dashed yellow on 10 m streets, a stop line per approach 4.5-5.0 m before the junction (behind the zebra). Paint stops 4.4 m from a junction edge and at the plaza.
- Signs on the driver's right per approach: pedestrian-crossing diamond at 4.2 m, signal-ahead diamond at 18 m. Symbols only: no text glyph pipeline, so no STOP/NO TURN ON RED lettering yet.
- Verified in a plain three.js page (top view and driver view); not yet in the live console. Posts have no collision.

## Lettered signs (roadsigns.py)
- Generator: `python3 tools/city3/roadsigns.py` (needs `plan.json`, Pillow, matplotlib's DejaVuSans-Bold) -> `apps/console/public/assets/world-roadsigns.glb` (~290 KB, committed), loaded by `RoadSigns.tsx`. One embedded PNG per design (2 regulatory + 10 street names), so no duplicate-PNG growth.
- NO TURN ON RED 2 m before each approach's junction edge, SPEED LIMIT 25 at 32 m, both on the driver's right curb; two street-name blades per junction on a post at the NE corner (east edge, 2.5 m north of the signal post). Street names are placeholders (plan.json has none).
- Not enforced: the NO TURN ON RED sign is lettering only; the lab/sim does not read it from the Bazaar. Verified in a plain three.js page, not the live console.

## Collision for posts and signs
- `StreetFurnitureColliders.tsx` registers the signals and roadmarks GLB meshes in `DistrictWorld`'s collider set (the walker and the camera both read it), via `streetFurniture.ts` `solidParts`, which drops the `mark_*` paint decals (5 cm proud: they must not become ground). Shared geometry, so BVHs are built once. Test: `streetFurnitureColliders.test.ts` walks a real walker into a signal post and a sign pole from the real GLBs.

## Controller (supersedes the fixed 12/3/1.5 plan above)
- `packages/world-sim/src/trafficSignals.ts`: pure function of the wall clock (`Date.now()`), so signals run continuously, match across viewers and are readable by the sim and the driving lab.
- Pretimed two-phase cycle, 60 s: avenue junctions give the avenue 28 s green and the side street 22 s, side-street junctions 25/25; yellow 3.5 s, all-red 1.5 s after each yellow.
- Coordination: each junction is offset by (x_street + y_street) / 11 m/s, a green wave at about 25 mph.
- Pedestrian heads (one under every vehicle head, same facing and phase): WALK 7 s, flashing DON'T WALK for the rest of the green and the yellow, then steady DON'T WALK.
- The GLB holds only posts and heads. Lamps are rows in `signalLamps.json` (480, written by `signals.py`) drawn as one instanced mesh with per-instance colour in `IntersectionSignals.tsx`.
- Tests: `bun test packages/world-sim/src/trafficSignals.test.ts` (no conflicting greens, durations, ped sequence, manifest matches the TS junction list).
- Not modelled: protected left-turn arrows, vehicle detection (actuated), night flash, time-of-day plans.

## Ambient traffic and pedestrians (server bodies, shared by every viewer)
- `packages/world-sim/src/ambientTraffic.ts` (pure, tested): 4 lane-correct loops of the street grid (ring and outer CCW on the outer lane, wide and tall CW on the inner lane, so no two loops share a lane direction and loops meet only at signalled junctions). Cars stop 5.2 m before a junction on red, on yellow when they can stop at 3.2 m/s^2, follow the car ahead, and never enter the plaza. Pedestrians wait at the kerb of a zebra and step off only on WALK, then finish the crossing.
- `ambientWorld.ts` runs it inside `apps/sim` (`WorldService({ ambient })`, off with `SIM_AMBIENT=0`) and publishes cars (body `car`) and pedestrians (body `business`) as ordinary server bodies: numbers from 1,000,000, roster ids `npc:*` (the gateway never looks them up and names them ""). Every viewer therefore sees the same cars and pedestrians; the console draws them through `RemoteCast` (`RemoteCar.tsx` for cars).
- Signals are the wall clock (`trafficSignals.ts`), so the cars and pedestrians stop for the same red the lamps show.
- Limits: NPCs are not obstacles for agent bodies or the lab driver (the sim's capsule world does not know them); cars stay on their loops, ignore the player and parked cars, and a car past its stop line when the light turns red runs through. The first version ran client-side (PR #226, `AmbientLife.tsx`) and gave every viewer a different street; it was removed.
- Parked car 2 moved from plan y=62 (a lane of the wide loop) to y=56.

- Resident cars draw `car-npc.glb` (tools/city3/lod_car.py: one mesh per material, 45k tris, wheels kept at 85%), not the 213k-tri `car-concept.glb`. Measured on production with the stream on: 14 NPCs added ~650 draw calls and 1.4 M triangles per frame, almost all from the 8 full cars.
