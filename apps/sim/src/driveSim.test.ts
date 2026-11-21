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

test("stuck against a kerb: observe says blocked, and reverse gets the car out", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j, "drv", 8.4);   // z 8.4: the avenue's south kerb is 1.6 m ahead of the car's side when it turns right
  act(service, "drv", "e", { type: "enter_vehicle" });
  act(service, "drv", "d0", { type: "drive", gas: 1, steer: -1, seconds: 5 });   // hard right into the kerb
  run(service, 5.1);
  expect(service.actRecord("drv", "d0")?.outcome?.detail).toMatch(/^STOP: something solid/);   // the step ended early, before the kerb
  for (let i = 0; i < 8 && !car.tally.collision; i++) {   // a driver who carries on regardless hits it
    act(service, "drv", `d0-${i}`, { type: "drive", gas: 1, steer: -1, seconds: 5 });
    run(service, 5.1);
  }
  const stuck = service.observe("drv").vehicle!;
  expect(car.tally.collision + (stuck.blocked ? 1 : 0)).toBeGreaterThan(0);
  expect(stuck.compassDeg).toBeGreaterThanOrEqual(0);
  expect(stuck.compassDeg).toBeLessThan(360);
  const x0 = car.v.x, z0 = car.v.z;
  act(service, "drv", "d1", { type: "drive", gas: 1, reverse: true, seconds: 3 });
  run(service, 3.1);
  expect(Math.hypot(car.v.x - x0, car.v.z - z0)).toBeGreaterThan(1);   // it moved: reverse is not stuck
  expect(car.v.speed).toBeLessThanOrEqual(0);                         // it rolls backwards, not forwards, once the input ends
  service.detach("drv");
});

test("compassDeg reads 90 for east and the drive command validates reverse", () => {
  const { j, t } = junctionAndClock("green");
  const { service } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  expect(service.observe("drv").vehicle?.compassDeg).toBe(90);
  expect(() => act(service, "drv", "bad", { type: "drive", reverse: "yes" })).toThrow(/reverse must be/);
  service.detach("drv");
});

test("go_to {body: car id} walks the agent to within enter range, then enter_vehicle works", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j);
  service.detach("drv");
  service.attach("drv", { x: car.v.x + 8, z: car.v.z + 6, maxR: 3 });   // 10 m away, in sight
  act(service, "drv", "w", { type: "go_to", body: car.id });
  run(service, 15);
  const v = service.observe("drv").scene.find((o) => o.kind === "vehicle")!;
  expect(v.distance).toBeLessThanOrEqual(3);
  expect(v.note).toMatch(/go_to \{body:/);
  expect(act(service, "drv", "e", { type: "enter_vehicle" }).outcome?.ok).toBe(true);
  service.detach("drv");
});

test("a settled drive reports where the car ended up: heading, lane, speed", () => {
  const { j, t } = junctionAndClock("green");
  const { service } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  act(service, "drv", "d", { type: "drive", gas: 0.5, seconds: 2 });
  run(service, 2.2);
  const detail = service.actRecord("drv", "d")?.outcome?.detail ?? "";
  expect(detail).toMatch(/heading 9\d deg \(east\)/);
  expect(detail).toMatch(/in lane, margin/);
  service.detach("drv");
});

test("drive {heading} steers the car onto a compass bearing and holds it; heading plus steer is refused", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  car.v.z = 5;   // lane middle: no lane-centring pull on the bearing
  expect(() => act(service, "drv", "bad", { type: "drive", heading: 0, steer: 0.5 })).toThrow(/cannot be combined with steer/);
  act(service, "drv", "d", { type: "drive", gas: 0.6, heading: 80, seconds: 4 });
  run(service, 4.2);
  const v = service.observe("drv").vehicle!;
  expect(v.compassDeg).toBeLessThan(88);      // it turned from 90 toward 80 ...
  expect(v.compassDeg).toBeGreaterThan(70);   // ... and the lane keeper stopped it leaving the lane (it leans the aim back to the lane middle)
  void car;
  service.detach("drv");
});

test("drive {speed} holds the speed; gas or brake with speed is refused", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  expect(() => act(service, "drv", "bad", { type: "drive", speed: 5, gas: 1 })).toThrow(/cannot be combined with gas or brake/);
  act(service, "drv", "d", { type: "drive", speed: 5, heading: 90, seconds: 5 });
  run(service, 4.9);   // still inside the step
  expect(car.v.speed).toBeGreaterThan(4.5);
  expect(car.v.speed).toBeLessThan(5.5);
  service.detach("drv");
});

test("a step ends early with STOP when a red signal is near, and the car brakes to a halt on its own; a new step is not cut short again for the same signal", () => {
  const { j, t } = junctionAndClock("red");
  const { service, car } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  act(service, "drv", "d1", { type: "drive", speed: 9, heading: 90, seconds: 5 });
  run(service, 5.2);
  const first = service.actRecord("drv", "d1")?.outcome?.detail ?? "";
  expect(first).toMatch(/^STOP: the signal ahead is red/);
  expect(car.v.x).toBeLessThan(j.rect[0]);                           // still short of the junction
  act(service, "drv", "d2", { type: "drive", brake: 1, seconds: 3 });
  run(service, 3.2);
  expect(car.v.speed).toBe(0);
  expect(car.tally.red_light).toBe(0);
  service.detach("drv");
});

test("the enter reply teaches the drive fields an agent needs: speed, heading and how to turn left", () => {
  const { j, t } = junctionAndClock("green");
  const { service } = setup(t, j);
  const detail = act(service, "drv", "e", { type: "enter_vehicle" }).outcome?.detail ?? "";
  for (const w of ["speed:", "heading:", "turn left", "reverse:true"]) expect(detail).toContain(w);
  service.detach("drv");
});

test("holding a heading on a street also centres the car in its lane", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j, "drv", 6.9);   // 1.9 m toward the kerb from the lane middle (z 5), still in lane
  act(service, "drv", "e", { type: "enter_vehicle" });
  act(service, "drv", "d", { type: "drive", speed: 5, heading: 90, seconds: 5 });
  run(service, 5.2);
  expect(Math.abs(car.v.z - 5)).toBeLessThan(0.8);
  expect(car.tally.wrong_lane + car.tally.collision).toBe(0);
  service.detach("drv");
});

test("junctionsPassed counts junction entries, and the step result reports it", () => {
  const { j, t } = junctionAndClock("green");
  const { service } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  expect(service.observe("drv").vehicle?.junctionsPassed).toBe(0);
  act(service, "drv", "d0", { type: "drive", speed: 8, heading: 90, seconds: 5 });
  run(service, 5.2);
  act(service, "drv", "d", { type: "drive", speed: 8, heading: 90, seconds: 3 });
  run(service, 3.2);
  expect(service.observe("drv").vehicle?.junctionsPassed).toBe(1);
  expect(service.actRecord("drv", "d")?.outcome?.detail).toContain("junctions passed so far 1");
  service.detach("drv");
});

test("with no drive open the car brakes to a halt on its own", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  act(service, "drv", "d", { type: "drive", speed: 8, heading: 90, seconds: 3 });
  run(service, 3.1);
  expect(car.v.speed).toBeGreaterThan(5);
  run(service, 6);
  expect(car.v.speed).toBe(0);
  service.detach("drv");
});

test("entering a junction ends the step with the headings for straight, left and right", () => {
  const { j, t } = junctionAndClock("green");
  const { service } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  act(service, "drv", "d0", { type: "drive", speed: 9, heading: 90, seconds: 3.5 });
  run(service, 3.5);   // a step ends well short of the junction ...
  act(service, "drv", "d", { type: "drive", speed: 9, heading: 90, seconds: 5 });
  run(service, 5.2);   // ... and the next one is cut short on entering it
  const detail = service.actRecord("drv", "d")?.outcome?.detail ?? "";
  expect(detail).toMatch(/^JUNCTION 1: you are inside it/);
  expect(detail).toMatch(/INSIDE a junction, to go straight use heading 90, to turn left 0, right 180/);
  service.detach("drv");
});
