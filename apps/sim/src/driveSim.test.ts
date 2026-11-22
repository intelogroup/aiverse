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
function setup(clock: number, j: (typeof JUNCTIONS)[number], agent = "drv", z = 2.5, back = 30) {
  const service = new WorldService({ sim, nowS: () => clock });
  services.push(service);
  const car = service.fleet.byId("car-east")!;
  Object.assign(car.v, { x: j.rect[0] - back, y: 0.2, z, heading: EAST, speed: 0 });   // z 2.5 = plan y -2.5 = south side: the east lane
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
  const { service, car } = setup(t, j, "drv", -4, 100);   // north side while heading east
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
  const { service, car } = setup(t, j, "drv", 2.5, 100);
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
  act(service, "drv", "d", { type: "drive", gas: 0.6, heading: 60, seconds: 4 });   // 30 deg off the axis: a real turn (within 20 deg of an axis the heading snaps to it)
  run(service, 4.2);
  const v = service.observe("drv").vehicle!;
  expect(v.compassDeg).toBeLessThan(88);      // it turned from 90 toward 60 ...
  expect(v.compassDeg).toBeGreaterThan(55);   // ... and the lane keeper stopped it leaving the lane (it leans the aim back to the lane middle)
  void car;
  service.detach("drv");
});

test("drive {speed} holds the speed; gas or brake with speed is refused", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j, "drv", 2.5, 100);
  act(service, "drv", "e", { type: "enter_vehicle" });
  expect(() => act(service, "drv", "bad", { type: "drive", speed: 5, gas: 1 })).toThrow(/cannot be combined with gas or brake/);
  Object.assign(car.v, { x: 15, z: 5, speed: 3 });   // between junctions: nothing within the warning distance of a 3 s step
  act(service, "drv", "d", { type: "drive", speed: 5, heading: 90, seconds: 5 });
  run(service, 3);   // still inside the step
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
  for (const w of ["speed:", "heading:", 'turn: "left"', "reverse:true"]) expect(detail).toContain(w);
  service.detach("drv");
});

test("holding a heading on a street also centres the car in its lane", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j, "drv", 6.9, 100);   // 1.9 m toward the kerb from the lane middle (z 5), still in lane
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
  for (let i = 0; i < 4; i++) { act(service, "drv", `d${i}`, { type: "drive", speed: 8, heading: 90, seconds: 3 }); run(service, 3.2); }   // JUNCTION AHEAD cuts the first short
  expect(service.observe("drv").vehicle?.junctionsPassed).toBe(1);
  expect(["d0", "d1", "d2", "d3"].map((id) => service.actRecord("drv", id)?.outcome?.detail ?? "").join(" | ")).toContain("junctions passed so far 1");
  service.detach("drv");
});

test("with no drive open the car brakes to a halt on its own", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j, "drv", 2.5, 100);
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

test("a held left turn at a junction swings the car onto the new street's lane", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  // just inside the junction at its west edge, heading east in the east lane, then hold north
  Object.assign(car.v, { x: j.rect[0] + 1, z: 5, heading: Math.PI / 2, speed: 3 });
  const lane = (j.rect[0] + j.rect[2]) / 2 + 2.5;   // north-bound lane of the crossing street (east of its centre line)
  act(service, "drv", "d0", { type: "drive", speed: 3, heading: 90, seconds: 0.5 });   // the JUNCTION step end the agent would have got
  run(service, 0.6);
  act(service, "drv", "d", { type: "drive", speed: 4, heading: 0, seconds: 5 });
  run(service, 5.2);
  const off = Math.round(((180 - car.v.heading * 180 / Math.PI) % 360 + 360) % 360);   // degrees from north, 0..359
  expect(Math.min(off, 360 - off)).toBeLessThan(20);   // either side of north: a car no longer cut short by a lamp may still be swinging
  expect(Math.abs(car.v.x - lane)).toBeLessThan(3);
  expect(car.tally.collision).toBe(0);
  service.detach("drv");
});

test("drive {turn:left} keeps the heading to the junction, turns inside it onto the new lane and ends the step", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j);   // east lane, 30 m before the junction
  act(service, "drv", "e", { type: "enter_vehicle" });
  act(service, "drv", "d", { type: "drive", speed: 6, turn: "left" });   // no seconds: a hold mode runs a full 5 s step, and a turn in progress is let finish
  run(service, 14);
  expect(service.actRecord("drv", "d")?.outcome?.detail ?? "").toMatch(/^TURNED left at junction \d+: now heading 0/);
  expect(Math.abs(car.v.x - ((j.rect[0] + j.rect[2]) / 2 + 1.8))).toBeLessThan(2.6);   // on the lane, still settling toward the clear line of the northbound lane
  expect(car.tally.collision + car.tally.wrong_lane + car.tally.red_light).toBe(0);
  service.detach("drv");
});

test("drive {turn:right} is still heading along the avenue when it enters the junction, so the signal judges it green", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  act(service, "drv", "d", { type: "drive", speed: 6, turn: "right" });
  run(service, 14);
  expect(service.actRecord("drv", "d")?.outcome?.detail ?? "").toMatch(/^TURNED right at junction \d+: now heading 180/);
  expect(Math.abs(car.v.x - ((j.rect[0] + j.rect[2]) / 2 - 1.8))).toBeLessThan(2.6);   // the southbound lane, still settling
  expect(car.tally.red_light + car.tally.collision + car.tally.wrong_lane).toBe(0);
  service.detach("drv");
});

test("a left turn off a 10 m street clears the signal post on its centre line, and the car drives on down the new street", () => {
  const j = JUNCTIONS.find((q) => q.rect[0] === 125 && q.rect[1] === 60 && q.rect[3] === 70)!;   // plan (130, 65) = world z -65: north-south street meets east-west street
  let clock = 0; for (let t = 0; t < 400; t += 0.5) { const s = signalState(j, t); if (s.ns === "green" && s.changesIn >= 22) { clock = t; break; } }
  const service = new WorldService({ sim, nowS: () => clock });
  services.push(service);
  const car = service.fleet.byId("car-east")!;
  Object.assign(car.v, { x: 131.8, y: 0.2, z: -39, heading: Math.PI, speed: 6 });   // northbound lane, 26 m before the cell
  service.attach("drv", { x: 133, z: -37.5, maxR: 3 });
  act(service, "drv", "e", { type: "enter_vehicle" });
  let detail = "";
  for (let k = 0; k < 4 && !detail.startsWith("TURNED"); k++) {
    act(service, "drv", "t" + k, { type: "drive", speed: 6, turn: "left" });
    for (let i = 0; i < 400 && !service.actRecord("drv", "t" + k)?.outcome?.detail; i++) { run(service, 0.05); clock += 0.05; }
    detail = service.actRecord("drv", "t" + k)?.outcome?.detail ?? "";
  }
  expect(detail).toMatch(/^TURNED left at junction \d+: now heading 270/);
  expect(Math.abs(Math.atan2(Math.sin(car.v.heading + Math.PI / 2), Math.cos(car.v.heading + Math.PI / 2)))).toBeLessThan(0.15);   // lined up on the new street, not still swinging
  act(service, "drv", "w", { type: "drive", speed: 6, heading: 270, seconds: 5 });
  for (let i = 0; i < 400 && !service.actRecord("drv", "w")?.outcome?.detail; i++) { run(service, 0.05); clock += 0.05; }
  expect(car.tally.collision + car.tally.red_light).toBe(0);
  expect(car.v.x).toBeLessThan(126);   // out of the cell, on its way west
  service.detach("drv");
});

test("turn is refused with heading, steer or reverse, and with anything but left or right", () => {
  const { j, t } = junctionAndClock("green");
  const { service } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  for (const [i, bad] of [{ turn: "left", heading: 0 }, { turn: "left", steer: 1 }, { turn: "left", reverse: true }, { turn: "up" }].entries()) {
    expect(() => service.act("drv", `bad-${i}`, { type: "drive", ...bad } as never)).toThrow(/turn must be/);
  }
  service.detach("drv");
});

test("a junction ahead on a green ends the step with JUNCTION AHEAD and the car brakes to a halt short of it; a turn drive is not cut short", () => {
  const { j, t } = junctionAndClock("green");
  const { service, car } = setup(t, j);
  act(service, "drv", "e", { type: "enter_vehicle" });
  act(service, "drv", "d", { type: "drive", speed: 8, heading: 90, seconds: 5 });
  run(service, 5.2);
  expect(service.actRecord("drv", "d")?.outcome?.detail).toMatch(/^JUNCTION AHEAD: junction 1 is \d+ m ahead, the signal is green\. To turn there send drive \{speed: 5, turn:/);
  run(service, 4);
  expect(car.v.speed).toBe(0);
  expect(car.v.x).toBeLessThan(j.rect[0] - 8);
  act(service, "drv", "d2", { type: "drive", speed: 5, heading: 90, seconds: 3 });   // the same junction is not announced twice
  run(service, 3.2);
  expect(service.actRecord("drv", "d2")?.outcome?.detail).not.toMatch(/JUNCTION AHEAD/);
  service.detach("drv");
});

test("the red car is parked on the west back street, away from the tower, and drives north through the first junction clean", () => {
  const j = JUNCTIONS.find((q) => q.rect[0] === -135 && q.rect[1] === 60 && q.rect[3] === 70)!;   // plan (-130, 65) = world z -65, on the car's street
  let clock = 0; for (let t = 0; t < 400; t += 0.5) { const s = signalState(j, t); if (s.ns === "green" && s.changesIn >= 30) { clock = t; break; } }
  const service = new WorldService({ sim, nowS: () => clock });
  services.push(service);
  const car = service.fleet.byId("car-east")!;   // untouched: this is where a visitor finds it
  expect(Math.hypot(car.v.x, car.v.z)).toBeGreaterThan(100);   // the tower stands at the plaza's centre
  expect(Math.abs(car.v.x + 130)).toBeLessThan(5);             // on the 10 m street at x -130
  service.attach("drv", { x: car.v.x + 1.8, z: car.v.z, maxR: 3 });
  expect(act(service, "drv", "e", { type: "enter_vehicle" }).outcome?.ok).toBe(true);
  for (let k = 0; k < 8 && car.v.z > -80; k++) {
    act(service, "drv", "d" + k, { type: "drive", speed: 6, heading: 0, seconds: 5 });
    for (let i = 0; i < 400 && !service.actRecord("drv", "d" + k)?.outcome?.detail; i++) { run(service, 0.05); clock += 0.05; }
  }
  expect(car.v.z).toBeLessThan(-80);   // through the junction at z -65
  expect(car.tally.collision + car.tally.red_light + car.tally.wrong_lane).toBe(0);
  service.detach("drv");
});

test("a speed-only drive after a right turn holds the street axis and stays in its lane to the next junction", () => {
  const j = JUNCTIONS.find((q) => q.rect[0] === -135 && q.rect[1] === 60 && q.rect[3] === 70)!;
  let clock = 0; for (let t = 0; t < 400; t += 0.5) { const s = signalState(j, t); if (s.ns === "green" && s.ew === "red" && s.changesIn >= 30) { clock = t; break; } }
  const service = new WorldService({ sim, nowS: () => clock });
  services.push(service);
  const car = service.fleet.byId("car-east")!;
  service.attach("drv", { x: car.v.x + 1.8, z: car.v.z, maxR: 3 });
  expect(act(service, "drv", "e", { type: "enter_vehicle" }).outcome?.ok).toBe(true);
  const step = (id: string, a: object) => {
    act(service, "drv", id, { type: "drive", ...a });
    for (let i = 0; i < 400 && !service.actRecord("drv", id)?.outcome?.detail; i++) { run(service, 0.05); clock += 0.05; }
  };
  for (let k = 0; k < 6 && car.v.z > -60; k++) step("n" + k, { speed: 6, heading: 0 });
  step("t", { speed: 5, turn: "right" });
  expect(car.v.x).toBeGreaterThan(-118);
  for (let k = 0; k < 3; k++) step("s" + k, { speed: 5 });   // east on z -65 with no heading: the car must hold the axis by itself
  expect(Math.abs(car.v.z + 63.2)).toBeLessThan(1.5);          // right-hand lane of the 10 m street, not 5 m south of it
  expect(car.tally.collision).toBe(0);
  service.detach("drv");
});

test("a turn armed closer than the run-up to the junction is refused with advice to reverse, and from 12 m back it ends in the right lane", () => {
  const j = JUNCTIONS.find((q) => q.rect[0] === -135 && q.rect[1] === 60 && q.rect[3] === 70)!;
  let clock = 0; for (let t = 0; t < 400; t += 0.5) { const s = signalState(j, t); if (s.ns === "green" && s.ew === "red" && s.changesIn >= 30) { clock = t; break; } }
  const make = (dist: number) => {
    const service = new WorldService({ sim, nowS: () => clock });
    services.push(service);
    const car = service.fleet.byId("car-east")!;
    Object.assign(car.v, { x: -127.5, y: 0.2, z: -(j.rect[1] - dist), heading: Math.PI, speed: 0 });   // right lane of the north-going street, `dist` m short of the cell
    service.attach("drv", { x: car.v.x - 1.2, z: car.v.z, maxR: 3 });
    expect(act(service, "drv", "e", { type: "enter_vehicle" }).outcome?.ok).toBe(true);
    return { service, car };
  };
  const near = make(4);   // gate census run 2: the turn was sent 2 m short and the car stopped across the centre line
  const refused = near.service.act("drv", "t", { type: "drive", speed: 5, turn: "right" }).outcome;
  expect(refused?.ok).toBe(false);
  expect(refused?.detail).toMatch(/too close to turn.*Reverse/);
  near.service.detach("drv");
  const far = make(12);
  const ok = far.service.act("drv", "t", { type: "drive", speed: 5, turn: "right" }).outcome;
  expect(ok?.ok).not.toBe(false);
  for (let i = 0; i < 800 && !far.service.actRecord("drv", "t")?.outcome?.detail; i++) run(far.service, 0.05);
  expect(far.car.v.x).toBeGreaterThan(-122);                   // round the corner and on east
  expect(far.car.tally.collision + far.car.tally.wrong_lane).toBe(0);
  far.service.detach("drv");
});

test("a heading 18 deg off the street axis is taken as the axis (a cold agent says east with 108) and the car stays in its lane", () => {
  const j = JUNCTIONS.find((q) => q.rect[0] === -135 && q.rect[1] === 60 && q.rect[3] === 70)!;
  let clock = 0; for (let t = 0; t < 400; t += 0.5) { const s = signalState(j, t); if (s.ns === "green" && s.ew === "red" && s.changesIn >= 30) { clock = t; break; } }
  const service = new WorldService({ sim, nowS: () => clock });
  services.push(service);
  const car = service.fleet.byId("car-east")!;
  service.attach("drv", { x: car.v.x + 1.8, z: car.v.z, maxR: 3 });
  expect(act(service, "drv", "e", { type: "enter_vehicle" }).outcome?.ok).toBe(true);
  const step = (id: string, a: object) => {
    act(service, "drv", id, { type: "drive", ...a });
    for (let i = 0; i < 400 && !service.actRecord("drv", id)?.outcome?.detail; i++) { run(service, 0.05); clock += 0.05; }
  };
  for (let k = 0; k < 6 && car.v.z > -60; k++) step("n" + k, { speed: 6, heading: 0 });
  step("t", { speed: 5, turn: "right" });
  expect(car.v.x).toBeGreaterThan(-118);
  for (let k = 0; k < 3; k++) step("s" + k, { speed: 5, heading: 108 });   // compass 108 is 18 deg south of east: held as given it drove into the shop plinth
  expect(Math.abs(car.v.z + 63.2)).toBeLessThan(1.5);          // right-hand lane of the 10 m street
  expect(car.tally.collision).toBe(0);
  service.detach("drv");
});

/** The red car on the west back street at plan x -130, put at world z `z0` facing `heading`, a green clock for the whole street, its driver in. */
function backStreetDrive(z0: number, heading: number) {
  let clock = 0;
  for (let t = 0; t < 400; t += 0.5) if (JUNCTIONS.every((q) => { const s = signalState(q, t); return s.ns === "green" && s.changesIn >= 60; })) { clock = t; break; }
  const service = new WorldService({ sim, nowS: () => clock });
  services.push(service);
  const car = service.fleet.byId("car-east")!;
  Object.assign(car.v, { z: z0, heading, speed: 0 });
  service.attach("drv", { x: car.v.x + 1.8, z: car.v.z, maxR: 3 });
  expect(act(service, "drv", "e", { type: "enter_vehicle" }).outcome?.ok).toBe(true);
  let n = 0;
  const step = (a: object) => {
    const id = "s" + n++;
    act(service, "drv", id, { type: "drive", ...a });
    for (let i = 0; i < 400 && !service.actRecord("drv", id)?.outcome?.detail; i++) { run(service, 0.05); clock += 0.05; }
    return service.actRecord("drv", id)?.outcome?.detail ?? "";
  };
  return { service, car, step };
}

test("driving straight on toward the end of the street grid stops the car short of the edge with END OF ROAD, and reversing gets it out", () => {
  const { service, car, step } = backStreetDrive(-90, Math.PI);   // facing north, the last junction (world z -130) and then the edge (z -135) ahead
  let detail = "";
  for (let k = 0; k < 12 && !/END OF ROAD/.test(detail); k++) detail = step({ speed: 6 });
  for (let k = 0; k < 4; k++) { step({ speed: 6 }); expect(car.v.z).toBeGreaterThan(-132); }   // pressing on never gets closer than 3 m of the edge
  expect(car.v.z).toBeGreaterThan(-132);
  expect(detail).toMatch(/END OF ROAD/);
  expect(detail).toContain("reverse:true");
  expect(car.tally.collision).toBe(0);
  run(service, 4);   // the halt note comes while the car is still rolling; it brakes to a stop by itself
  expect(car.v.speed).toBe(0);
  const zEnd = car.v.z;
  step({ gas: 1, reverse: true, seconds: 3 });
  expect(car.v.z).toBeGreaterThan(zEnd + 2);   // backed away from the edge
  expect(car.tally.collision).toBe(0);
  service.detach("drv");
});

test("the end-of-road halt works toward the south edge too", () => {
  const { service, car, step } = backStreetDrive(90, 0);   // facing south
  let detail = "";
  for (let k = 0; k < 12 && !/END OF ROAD/.test(detail); k++) detail = step({ speed: 6 });
  for (let k = 0; k < 4; k++) { step({ speed: 6 }); expect(car.v.z).toBeLessThan(132); }
  expect(detail).toMatch(/END OF ROAD/);
  expect(car.tally.collision).toBe(0);
  service.detach("drv");
});

test("steer sent together with speed is dropped and the car holds its street: a weak agent mixing them does not drift off the lane", () => {
  const { car, step } = backStreetDrive(-90, Math.PI);   // facing north on the back street
  const detail = step({ speed: 6, steer: 0.6, seconds: 4 });
  expect(detail).toMatch(/steer.*ignored/i);
  expect(Math.abs(Math.atan2(Math.sin(car.v.heading - Math.PI), Math.cos(car.v.heading - Math.PI)))).toBeLessThan(0.1);
  expect(car.tally.collision).toBe(0);
});
