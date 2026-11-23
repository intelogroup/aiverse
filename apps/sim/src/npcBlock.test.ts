import { beforeAll, expect, test } from "bun:test";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { AmbientWorld } from "@aiverse/world-sim/ambientWorld";
import { sample } from "@aiverse/world-sim/ambientTraffic";
import { WorldService } from "@aiverse/world-sim/worldService";

const ASSETS = new URL("../../console/public/assets/", import.meta.url).pathname;
let sim: Awaited<ReturnType<typeof loadVerseSim>>["sim"];
beforeAll(async () => { sim = (await loadVerseSim(ASSETS)).sim; }, 120_000);

/** Walk an agent along a fixed route; with `blocker`, a pedestrian-sized resident disc stands on the route (published as WorldService.tick publishes AmbientWorld NPCs). */
async function walk(id: string, blocker?: [number, number]): Promise<{ path: [number, number][]; status: string }> {
  const service = new WorldService({ sim });
  service.attach(id, { x: 68.75, z: 10.9 });
  service.act(id, "go-1", { type: "go_to", point: [76.5, 11.3] });
  const path: [number, number][] = [];
  for (let t = 0; t < 40; t += 0.1) {
    if (blocker) sim.publishDisc("npc:ped-test", blocker[0], 0.2, blocker[1], 0.35, 1.8);
    service.tick(0.1);
    await Promise.resolve();
    const o = service.observe(id).body;
    path.push([o.x, o.z]);
    if (service.actRecord(id, "go-1")?.state === "settled") break;
  }
  const status = service.actRecord(id, "go-1")?.outcome?.status ?? "running";
  service.detach(id);
  return { path, status };
}

test("an agent body does not walk through a resident disc", async () => {
  const free = await walk("npc-free");
  expect(free.status).toBe("arrived");
  const mid = free.path[Math.floor(free.path.length / 2)];
  const dist = (p: [number, number][]) => Math.min(...p.map(([x, z]) => Math.hypot(x - mid[0], z - mid[1])));
  expect(dist(free.path)).toBeLessThan(0.2);
  const hit = await walk("npc-block", mid);
  expect(dist(hit.path)).toBeGreaterThan(0.6);   // body 0.4 + pedestrian 0.35, less slack
}, 90_000);

test("the service publishes every resident car and pedestrian as solid discs", () => {
  const ambient = new AmbientWorld(() => 1_000_000, 2);
  const d = ambient.discs();
  expect(d.length).toBe(ambient.cars.length * 2 + ambient.walkers.length);
  expect(new Set(d.map((x) => x.id)).size).toBe(d.length);
  expect(d.every((x) => x.id.startsWith("npc:") && Number.isFinite(x.x) && Number.isFinite(x.z))).toBe(true);
});

test("a resident car stops for an agent body standing in its lane instead of driving through", async () => {
  let clock = 1_700_000_000;
  const ambient = new AmbientWorld(() => clock, 1);
  const service = new WorldService({ sim, ambient });
  const car = ambient.cars[0];
  const ahead = sample(car.loop, car.s + 40);
  service.attach("npc-yield", { x: ahead.x, z: -ahead.y });
  const me = service.observe("npc-yield").body;
  let minDist = Infinity;
  for (let t = 0; t < 25; t += 0.1) {
    clock += 0.1;
    service.tick(0.1);
    const p = sample(car.loop, car.s);
    minDist = Math.min(minDist, Math.hypot(p.x - me.x, -p.y - me.z));
  }
  service.detach("npc-yield");
  expect(minDist).toBeGreaterThan(2.5);   // a car's centre never gets within half a car + the body
  expect(car.v).toBeLessThan(0.5);
}, 60_000);

test("a resident car holds behind the parked red car in its lane, past the give-up a body gets, and drives on once it leaves", async () => {
  let clock = 1_700_000_000;
  const ambient = new AmbientWorld(() => clock, 1);
  const service = new WorldService({ sim, ambient });
  const wide = ambient.cars.find((c) => c.loop.id === "wide")!;
  const parked = service.fleet.byId("car-east")!;   // plan (-128.2, 14), in the wide loop's northbound lane since the lane fix
  // start the wide car 34 m south of the parked car on the same street, already rolling north
  let s0 = 0, best = Infinity;
  for (let s = 0; s < wide.loop.length; s += 0.25) { const p = sample(wide.loop, s); const d = Math.hypot(p.x - parked.v.x, p.y + parked.v.z + 34); if (d < best) { best = d; s0 = s; } }
  wide.s = s0; wide.v = 8;
  const dist = () => { const p = sample(wide.loop, wide.s); return Math.hypot(p.x - parked.v.x, p.y + parked.v.z); };
  let minDist = Infinity, held = false;
  for (let t = 0; t < 4000 && !held; t++) {
    clock += 0.1; service.tick(0.1);
    minDist = Math.min(minDist, dist());
    if (wide.v < 0.05 && dist() < 12) held = true;   // stopped in the queue behind the parked car, not at the junction
  }
  expect(held).toBe(true);
  expect(minDist).toBeGreaterThan(6);   // it stops a car's length short — the old geometry clipped the parked car's flank at 0.7 m
  for (let t = 0; t < 400; t++) { clock += 0.1; service.tick(0.1); minDist = Math.min(minDist, dist()); }   // 40 s: a body would be given up on by now
  expect(wide.v).toBeLessThan(0.05);
  expect(minDist).toBeGreaterThan(6);
  Object.assign(parked.v, { x: 120, z: 120 });   // the parked car leaves
  let passed = false;
  for (let t = 0; t < 2000 && !passed; t++) { clock += 0.1; service.tick(0.1); const p = sample(wide.loop, wide.s); if (Math.hypot(p.x + 128.2, p.y - 14) < 2) passed = true; }
  expect(passed).toBe(true);   // ... and the resident car drives on through the spot where it stood
}, 60_000);
