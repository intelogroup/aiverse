// Drivability probe: a scripted pure-pursuit driver follows the 65 m rectangle loop (avenue -> x=130 -> y=65 -> x=65 -> avenue) in the real City 3
// collision with the signals ignored. It answers one question before any model is asked to drive: can the loop be driven at all?
import { beforeAll, expect, test } from "bun:test";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";

const ASSETS = new URL("../../console/public/assets/", import.meta.url).pathname;
let sim: Awaited<ReturnType<typeof loadVerseSim>>["sim"];
beforeAll(async () => { sim = (await loadVerseSim(ASSETS)).sim; }, 120_000);

type P = [number, number];   // world x, z (z = -plan y)
// Right-hand lanes: avenue east lane plan y=-5 (z=5); x=130 north lane x=132.5; y=65 west lane plan y=67.5 (z=-67.5); x=65 south lane x=62.5.
const LOOP: P[] = [[40, 5], [118, 5], [127, 3.5], [131.8, -4], [131.8, -52], [128, -62], [120, -66.8], [72, -66.8], [64, -62], [63.2, -52], [63.2, -14], [64, -5], [68, 3.5], [100, 5]];
const wrap = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

test("a scripted driver can drive the whole loop with no collision", () => {
  const service = new WorldService({ sim, nowS: () => 0 });
  const car = service.fleet.byId("car-east")!;
  Object.assign(car.v, { x: LOOP[0][0], y: 0.2, z: LOOP[0][1], heading: Math.PI / 2, speed: 0 });
  service.attach("probe", { x: car.v.x, z: car.v.z + 1.8, maxR: 3 });
  expect(service.act("probe", "e", { type: "enter_vehicle" }).outcome?.ok).toBe(true);
  car.inputUntil = 1e9;
  let i = 1, t = 0, blockedAt: P | null = null, minX = 1e9;
  while (i < LOOP.length && t < 300) {
    const [tx, tz] = LOOP[i];
    if (Math.hypot(tx - car.v.x, tz - car.v.z) < 4) { i++; continue; }
    // look-ahead: steer at the waypoint after next when close, else the current one
    const err = wrap(Math.atan2(tx - car.v.x, tz - car.v.z) - car.v.heading);
    const want = Math.abs(err) > 0.5 ? 3.5 : 6.5;   // slow for the corners
    car.input = { gas: car.v.speed < want ? 1 : 0, brake: car.v.speed > want + 1 ? 0.5 : 0, steer: Math.max(-1, Math.min(1, err * 2.5)) };
    service.tick(0.05); t += 0.05; minX = Math.min(minX, car.v.x);
    if (car.v.speed === 0 && t > 3 && !blockedAt) { blockedAt = [Math.round(car.v.x * 10) / 10, Math.round(car.v.z * 10) / 10]; if (car.tally.collision || t > 10) break; }
  }
  console.log(`waypoint ${i}/${LOOP.length}, t=${t.toFixed(1)}s, at (${car.v.x.toFixed(1)}, ${car.v.z.toFixed(1)}), stalled at ${JSON.stringify(blockedAt)}, tally ${JSON.stringify(car.tally)}`);
  expect(car.tally.collision).toBe(0);
  expect(i).toBe(LOOP.length);
  service.detach("probe");
}, 120_000);

test("the red car's parked spot is clear: an agent beside it can get in and pull out east", () => {
  const service = new WorldService({ sim, nowS: () => 0 });
  const car = service.fleet.byId("car-east")!;
  service.attach("probe", { x: car.v.x, z: car.v.z + 1.8, maxR: 3 });
  expect(service.act("probe", "e", { type: "enter_vehicle" }).outcome?.ok).toBe(true);
  car.inputUntil = 1e9;
  for (let t = 0; t < 12; t += 0.05) {
    const err = wrap(Math.PI / 2 - car.v.heading);
    car.input = { gas: car.v.speed < 4 ? 1 : 0, brake: 0, steer: Math.max(-1, Math.min(1, err * 2.5)) };
    service.tick(0.05);
  }
  console.log(`parked-spot pull-out: at (${car.v.x.toFixed(1)}, ${car.v.z.toFixed(1)}) heading ${car.v.heading.toFixed(2)} tally ${JSON.stringify(car.tally)}`);
  expect(car.tally.collision).toBe(0);
  expect(car.v.x).toBeGreaterThan(30);
  service.detach("probe");
}, 60_000);
