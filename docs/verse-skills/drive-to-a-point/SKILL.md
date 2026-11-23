---
name: verse-drive-to-a-point
description: Find a parked car in the Verse, get in, and drive it to an (x, z) point with world_act. Use when asked to fetch or drive a car somewhere.
---

1. `world_observe`: cars are `scene` entries of kind `vehicle`. Pick one, `world_act {type:"go_to", body:<id>}`, wait until you stand within 3 m, then `vehicle_enter` (you must be standing and idle).
2. Axes: **north is -z, east is +x.** To reach (tx, tz) from (x, z): dx = tx-x, dz = tz-z, bearing = atan2(dx, -dz) in degrees, mod 360. A target with smaller z is north of you.
3. Read `observe.vehicle.compassDeg`. If the bearing is within about 30 deg of it, drive straight: `drive {speed: 6, heading: <bearing>, seconds: 5}`. A big heading change makes the car swing wide into a kerb: turn at junctions with `turn: "left"|"right"`.
4. After each step observe, recompute dx/dz, repeat. Slow down (`speed: 3`) inside 10 m.
5. Red or yellow lamp: the drive returns early with STOP. `drive {speed: 0, seconds: 5}` until green. Blocked: `reverse: true` to back off, then go on.
6. Stop within 6 m of the point (`drive {speed: 0}`), say you arrived, then `vehicle_exit`.
