import { afterEach, beforeAll, expect, test } from "bun:test";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";
import { JUNCTIONS, signalState } from "@aiverse/world-sim/trafficSignals";

const ASSETS = new URL("../../console/public/assets/", import.meta.url).pathname;
let sim: Awaited<ReturnType<typeof loadVerseSim>>["sim"];
beforeAll(async () => { sim = (await loadVerseSim(ASSETS)).sim; }, 120_000);

const services: WorldService[] = [];
afterEach(() => { for (const sv of services.splice(0)) for (const id of sv.agentIds()) sv.detach(id); });
const EAST = Math.PI / 2;
/** The first junction east of the avenue start, and a frozen clock at which east-west is `lamp` for at least 12 s. */
function junctionAndClock(lamp: "red" | "green") {
  const j = JUNCTIONS.filter((q) => q.rect[0] > 40 && (q.rect[1] + q.rect[3]) / 2 === 0).sort((a, b) => a.rect[0] - b.rect[0])[0];
  for (let t = 0; t < 200; t += 0.5) { const s = signalState(j, t); if (s.ew === lamp && s.changesIn >= 12) return { j, t }; }
  throw new Error("no phase");
}
/** A fresh service with the red car parked 30 m before junction `j` in its lane, facing east, and an agent standing beside it. */
function setup(clock: number, j: (typeof JUNCTIONS)[number], agent = "drv", z = 2.5) {
  const service = new WorldService({ sim, nowS: () => clock });
  services.push(service);
  const car = service.fleet.byId("car-east")!;
  Object.assign(car.v, { x: j.rect[0] - 30, y: 0.2, z, heading: EAST, speed: 0 });   // z 2.5 = plan y -2.5 = south side: the east lane
  service.attach(agent, { x: car.v.x, z: car.v.z + 1.8, maxR: 3 });
  return { service, car };
}
const run = (service: WorldService, seconds: number) => { for (let t = 0; t < seconds; t += 0.05) service.tick(0.05); };
const act = (service: WorldService, agent: string, id: string, a: object) => service.act(agent, id, a);

test("walking past a car does nothing; getting in is an explicit act", () => {
  const { j } = junctionAndClock("green");
  const { service, car } = setup(0, j);
  act(service, "drv", "w1", { type: "go_to", point: [car.v.x + 10, car.v.z + 1.8] });
  run(service, 6);
  expect(car.driver).toBeNull();
  expect(car.v.x).toBeCloseTo(j.rect[0] - 30, 3);
  expect(service.observe("drv").vehicle).toBeNull();
  const seen = service.observe("drv").scene.find((o) => o.kind === "vehicle" && o.id === "car-east");
  expect(seen?.state).toBe("free");
  service.detach("drv");
});

test("enter needs reach, then the car carries the driver and the figure leaves the stream", () => {
  const { j } = junctionAndClock("green");
  const { service, car } = setup(0, j);
  service.detach("drv");
  service.attach("far", { x: car.v.x, z: car.v.z + 20, maxR: 3 });
  const far = act(service, "far", "e0", { type: "enter_vehicle", vehicle: "car-east" });
  expect(far.outcome?.status).toBe("unavailable");
  expect(far.outcome?.detail).toMatch(/away/);
  service.detach("far");
  service.attach("drv", { x: car.v.x, z: car.v.z + 1.8, maxR: 3 });
  expect(act(service, "drv", "e1", { type: "enter_vehicle" }).outcome?.ok).toBe(true);
  expect(car.driver).toBe("drv");
  expect(act(service, "drv", "w2", { type: "go_to", point: [0, 0] }).outcome?.status).toBe("rejected");
  const n = service.roster().bodies.find((b) => b.agentId === "drv")!.n;
  expect(service.frames().b.some((p) => p[0] === n)).toBe(false);
  expect(service.roster().bodies.some((b) => b.agentId === "npc:veh-car-east" && b.body === "car")).toBe(true);
  service.detach("drv");
  expect(car.driver).toBeNull();
});

test("driving: gas moves the car and the driver; green light is clean; exit works", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  const x0 = car.v.x;
  act(service, "drv", "d1", { type: "drive", gas: 1, seconds: 3 });
  run(service, 3.1);
  expect(service.actRecord("drv", "d1")?.state).toBe("settled");
  expect(car.v.x).toBeGreaterThan(x0 + 5);
  const o = service.observe("drv");
  expect(Math.hypot(o.body.x - car.v.x, o.body.z - car.v.z)).toBeLessThan(0.01);
  expect(o.vehicle?.facing).toBe("east");
  expect(o.vehicle?.signal?.lamp).toBe("green");
  act(service, "drv", "d2", { type: "drive", brake: 1, seconds: 4 });
  run(service, 4.1);
  expect(car.v.speed).toBe(0);
  expect(service.observe("drv").vehicle?.infractions).toEqual({ red_light: 0, speeding: 0, wrong_lane: 0, collision: 0 });
  expect(act(service, "drv", "x", { type: "exit_vehicle" }).outcome?.ok).toBe(true);
  expect(car.driver).toBeNull();
  expect(service.observe("drv").vehicle).toBeNull();
  service.detach("drv");
});

test("running the red light and a wrong-way lane are reported to the driver", () => {
  const { j, t } = junctionAndClock("red");
  const { service, car } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  const o = service.observe("drv");
  expect(o.vehicle?.signal?.lamp).toBe("red");
  for (let i = 0; i < 8; i++) { act(service, "drv", `d${i}`, { type: "drive", gas: 1, seconds: 2 }); run(service, 2.05); }
  expect(car.tally.red_light).toBe(1);
  expect(car.tally.speeding).toBe(1);
  expect(service.observe("drv").vehicle?.recent.join("|")).toMatch(/red_light/);
  service.detach("drv");
});

test("the wrong side of the street is reported as wrong_lane", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j, "drv", -4);   // north side while heading east
  act(service, "drv", "e", { type: "enter_vehicle" });
  act(service, "drv", "d", { type: "drive", gas: 0.5, seconds: 5 });
  run(service, 5.1);
  act(service, "drv", "d2", { type: "drive", gas: 0.3, seconds: 5 });
  run(service, 5.1);
  expect(car.tally.wrong_lane).toBe(1);
  expect(service.actRecord("drv", "d")?.outcome?.detail).toMatch(/wrong_lane/);
  service.detach("drv");
});

test("a car stops against a body in its lane and reports the collision", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j);
  service.attach("blocker", { x: car.v.x + 14, z: car.v.z, maxR: 3 });
  act(service, "drv", "e", { type: "enter_vehicle" });
  for (let i = 0; i < 5; i++) { act(service, "drv", `d${i}`, { type: "drive", gas: 0.5, seconds: 2 }); run(service, 2.05); }
  expect(car.tally.collision).toBeGreaterThanOrEqual(1);
  expect(car.v.x).toBeLessThan(service.observe("blocker").body.x);
  service.detach("drv"); service.detach("blocker");
});
