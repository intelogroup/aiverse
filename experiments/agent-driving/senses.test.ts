import { expect, test } from "bun:test";
import { senseFeed, type SenseWorld } from "./senses";
import { DrivingSimulation } from "./simulation";
import { type DriveAction } from "./protocol";

async function act(sim: DrivingSimulation, input: DriveAction) {
  let complete = false;
  const result = sim.actAsDriver(input).finally(() => { complete = true; });
  await Promise.resolve();
  for (let i = 0; i < 1800 && !complete; i++) { sim.tick(1 / 60); await Promise.resolve(); }
  expect(complete).toBe(true);
  return result;
}

const world = ({ car, ...over }: Partial<Omit<SenseWorld, "car">> & { car?: Partial<SenseWorld["car"]> } = {}): SenseWorld => ({
  frontOffset: 2.45, stopLineZ: 2.5, crosswalkZ: 8, light: "red", sign: null, actors: [],
  ...over,
  car: { x: -1.9, z: -40, heading: 0, speed: 13, ...car },
});
const stopLine = (feed: ReturnType<typeof senseFeed>) => feed.horizon.find((event) => event.type === "stop_line")!;

test("stop line carries distance, time to arrival, a near-readable light and whether the car can still stop", () => {
  const event = stopLine(senseFeed(world()));
  expect(event).toMatchObject({ distanceM: 40.1, etaS: 3.1, light: "red", canStop: true });
});

test("a far light is unreadable, and a car too fast to stop before the line is told so", () => {
  expect(stopLine(senseFeed(world({ car: { z: -70 } })))).toMatchObject({ light: "unreadable" });
  expect(stopLine(senseFeed(world({ car: { z: -20, speed: 20 } })))).toMatchObject({ canStop: false });
});

test("a stopped car has no arrival time", () => {
  expect(stopLine(senseFeed(world({ car: { speed: 0 } }))).etaS).toBeNull();
});

test("blind-spot flag follows the car's own left and right, whatever its heading", () => {
  const left = senseFeed(world({ actors: [{ kind: "vehicle", x: 1.9, z: -45, heading: 0, moving: true }] }));
  expect(left.blindSpot).toEqual({ left: true, right: false });
  expect(left.nearby[0]).toMatchObject({ side: "left", kind: "vehicle" });
  // Same car, but we face +x: our left is now -z, so an actor at -z beside us is on the left.
  const turned = senseFeed(world({ car: { x: 0, z: 0, heading: Math.PI / 2 }, actors: [{ kind: "vehicle", x: -3, z: -3.8, heading: Math.PI / 2, moving: true }] }));
  expect(turned.blindSpot.left).toBe(true);
});

test("range and field of view limit what is sensed", () => {
  const feed = senseFeed(world({ actors: [
    { kind: "pedestrian", x: -1.9, z: -10, heading: 0, moving: false },   // 30 m ahead, in the cone
    { kind: "vehicle", x: -1.9, z: 60, heading: Math.PI, moving: true },  // 100 m away: out of range
    { kind: "vehicle", x: -1.9, z: -90, heading: 0, moving: true },       // 50 m behind: not sensed
  ] }));
  expect(feed.nearby.map((actor) => actor.kind)).toEqual(["pedestrian"]);
  expect(feed.horizon.find((event) => event.type === "crosswalk")).toMatchObject({ pedestrians: 1 });
});

test("a posted sign is reported only when near", () => {
  expect(senseFeed(world({ sign: "NO TURN ON RED", car: { z: -30 } })).horizon.some((event) => event.type === "sign")).toBe(true);
  expect(senseFeed(world({ sign: "NO TURN ON RED", car: { z: -60 } })).horizon.some((event) => event.type === "sign")).toBe(false);
});

test("the lesson feed flags the blind-spot car at the start of a lane change", async () => {
  const sim = new DrivingSimulation();
  sim.reset(0, "lane_change", undefined, true);
  await act(sim, { command: "enter" });
  const feed = sim.snapshot().lesson!.senses!;
  expect(feed.blindSpot.left).toBe(true);
  expect(feed.horizon).toEqual([]);
});

test("the intersection feed reports the stop line and the signed red", async () => {
  const sim = new DrivingSimulation();
  sim.reset(0, "no_turn_on_red", undefined, true);
  await act(sim, { command: "enter" });
  const feed = sim.snapshot().lesson!.senses!;
  expect(feed.horizon.find((event) => event.type === "stop_line")).toMatchObject({ light: "red" });
});
