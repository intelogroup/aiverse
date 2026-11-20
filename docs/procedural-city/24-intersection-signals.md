# Intersection signals (Bazaar)
Status 2026-11-20: 24 junctions x 4 corner posts, 3-lamp heads, fixed-time cycle. Not baked into `world-city3.glb`.

- Generator: `python3 tools/city3/signals.py` (pure python glTF writer, needs `tools/city3/plan.json` from `plan.py`) -> `apps/console/public/assets/world-signals.glb` (352 KB, committed). Junctions = street crossings outside the plaza (`plan.json` streets), same rule as `build_city.py` `INTS`.
- Layout: post 0.8 m beyond the junction corner on both axes, head 3.7-4.7 m up, head faces its own approach (right-hand traffic, far right corner): eastbound SE corner, westbound NW, northbound NE, southbound SW. Lamps stand 4 cm proud of the head (>= 3 cm z-fight rule).
- Lamps are separate meshes with materials `sig_<ns|ew>_<red|yellow|green>`; the runtime only sets `emissiveIntensity` (0.9 on, 0.04 off) when the phase changes.
- Runtime: `IntersectionSignals.tsx` (mounted in `DistrictWorld.tsx` beside `BazaarCar`), plan in `signalCycle.ts` (12 s green, 3 s yellow, 1.5 s all-red, per direction pair; test: never green to both). All junctions run the same clock.
- Verified by screenshot in a plain three.js page (overview, eye level, eastbound approach): heads face their approach, lit lamp reads correctly. Not yet checked inside the live console.
- Open: posts have no collision (a walker passes through them); no pedestrian signals; no per-junction offsets; the driving lab's light does not read this clock yet; vertical signs and lane/stop-line paint still to do.
