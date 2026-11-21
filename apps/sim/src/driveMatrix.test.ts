// Drive matrix: a scripted pilot that behaves like the weakest cold agent (it only reads the step result, sends `drive {speed}` and answers JUNCTION AHEAD
// with `turn`) drives every move (straight, left, right) through junctions of every kind, from all four approach headings, in the real City 3
// collision. It pins what the gate runs found: which moves are clean, and that a turn toward a street that does not exist is refused instead of
// driving the car into the edge of the grid. GATE_MATRIX=full runs all 25 junctions; the default runs one of each kind.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";
import { AmbientWorld } from "@aiverse/world-sim/ambientWorld";
import { JUNCTIONS, signalState, type Junction } from "@aiverse/world-sim/trafficSignals";
import { laneMiddle } from "@aiverse/world-sim/vehicle";

const ASSETS = new URL("../../console/public/assets/", import.meta.url).pathname;
let sim: Awaited<ReturnType<typeof loadVerseSim>>["sim"];
beforeAll(async () => { sim = (await loadVerseSim(ASSETS)).sim; }, 120_000);
const services: WorldService[] = [];
afterEach(() => { for (const sv of services.splice(0)) for (const id of sv.agentIds()) sv.detach(id); });

type V = readonly [number, number];                       // plan x (east), plan y (north)
const DIRS: { name: string; d: V }[] = [{ name: "north", d: [0, 1] }, { name: "east", d: [1, 0] }, { name: "south", d: [0, -1] }, { name: "west", d: [-1, 0] }];
const left = (d: V): V => [-d[1], d[0]], right = (d: V): V => [d[1], -d[0]];
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const GRID = 135;                                         // the outermost streets run at +-130 and are 10 m wide
const center = (j: Junction): V => [(j.rect[0] + j.rect[2]) / 2, (j.rect[1] + j.rect[3]) / 2];
/** Width of the street that runs along `d` through junction j. */
const widthAlong = (j: Junction, d: V) => (d[0] !== 0 ? j.rect[3] - j.rect[1] : j.rect[2] - j.rect[0]);
const headingOf = (d: V) => Math.atan2(d[0], -d[1]);      // world heading: faces (sin h, cos h) in (x, z), z = -plan y

type Move = "straight" | "left" | "right";
interface Result { x: number; z: number; refused: boolean; collisions: number; red: number; wrongLane: number; along: number; lateralErr: number; headingErr: number; steps: number; detail: string }

/** A clock at which the approach axis of `j` is green; the signals are frozen there so the run is about the car, not the lamp. */
function greenClock(j: Junction, d: V): number {
  const axis = d[0] !== 0 ? "ew" : "ns";
  for (let t = 0; t < 400; t += 0.5) { const s = signalState(j, t); if (s[axis] === "green" && s.changesIn >= 2) return t; }
  throw new Error("no green phase");
}

function pilot(j: Junction, d: V, move: Move, ambient?: AmbientWorld): Result {
  const clock = greenClock(j, d);
  const service = new WorldService({ sim, nowS: () => clock, ambient });
  services.push(service);
  const car = service.fleet.byId("car-east")!;
  const [cx, cy] = center(j), r = right(d), e = move === "straight" ? d : move === "left" ? left(d) : right(d), re = right(e);
  const lane = laneMiddle(widthAlong(j, d));
  const sx = cx - 40 * d[0] + lane * r[0], sy = cy - 40 * d[1] + lane * r[1];
  Object.assign(car.v, { x: sx, y: 0.2, z: -sy, heading: headingOf(d), speed: 0 });
  const side: V = [-Math.cos(car.v.heading), Math.sin(car.v.heading)];   // the car's right-hand side in world (x, z)
  service.attach("pilot", { x: car.v.x + 1.8 * side[0], z: car.v.z + 1.8 * side[1], maxR: 3 });
  const entered = service.act("pilot", "enter", { type: "enter_vehicle" }).outcome;
  if (!entered?.ok) throw new Error(`cannot enter at junction ${center(j).join(",")} heading ${headingOf(d).toFixed(2)}: ${entered?.detail}`);

  let detail = "", turned = false, refused = false, after = 0, steps = 0;
  const alongNow = () => (car.v.x - cx) * e[0] + (-car.v.z - cy) * e[1];
  while (steps < 18 && !refused) {
    const wantTurn = move !== "straight" && !turned && /JUNCTION AHEAD/.test(detail);
    // the weakest agent: no heading, no steer; short steps once turned so the next junction is not run before the car is measured
    const a = wantTurn ? { speed: 5, turn: move } : turned || move === "straight" ? { speed: 6, seconds: 2 } : { speed: 6 };
    const id = "s" + steps++;
    const rec = service.act("pilot", id, { type: "drive", ...a });
    if (rec.outcome && rec.outcome.ok === false) { refused = true; detail = rec.outcome.detail ?? ""; break; }
    for (let i = 0; i < 600 && !service.actRecord("pilot", id)?.outcome?.detail; i++) service.tick(0.05);
    detail = service.actRecord("pilot", id)?.outcome?.detail ?? "";
    if (wantTurn) turned = true;
    if (car.tally.collision) break;
    if (turned || move === "straight") { if (alongNow() > 8) after++; if (after >= 2 && alongNow() > 28) break; }
  }
  const lat = (car.v.x - cx) * re[0] + (-car.v.z - cy) * re[1];
  const out: Result = {
    x: car.v.x, z: car.v.z, refused, collisions: car.tally.collision, red: car.tally.red_light, wrongLane: car.tally.wrong_lane,
    along: alongNow(), lateralErr: Math.abs(lat - laneMiddle(widthAlong(j, e))), headingErr: Math.abs(wrap(car.v.heading - headingOf(e))), steps, detail,
  };
  service.detach("pilot");
  return out;
}

const full = process.env.GATE_MATRIX === "full";
// One junction of each kind: a corner of the grid, an edge of it, an interior 10 m crossing, one with a 20 m avenue.
const KINDS = [[-130, -130], [-130, -65], [-65, -65], [0, -65], [65, 65], [130, 130]];
const pick = (): Junction[] => full ? [...JUNCTIONS] : KINDS.map(([x, y]) => JUNCTIONS.find((j) => center(j)[0] === x && center(j)[1] === y)).filter((j): j is Junction => !!j);

/**
 * The approach to the junction at (0, -65) from the south, and the turns out of it from the west, hit something solid at the junction's edge
 * (a car at x 5 stops 1 m short of the cell with the signal green: a post or island in the lane; the car cannot get past). That is City 3
 * geometry (the 20 m street's signal furniture), not the drive contract, and it is the only junction that fails. Found by this matrix; the fix
 * belongs in tools/city3 (signals.py), after which these four pass and must be deleted from the list.
 */
const KNOWN_BAD = ["0,-65 north straight", "0,-65 north right", "0,-65 east left", "0,-65 east right"];

test("every move at every kind of junction: clean where there is a street, refused where there is none", () => {
  const bad: string[] = [];
  const tags: string[] = [];
  let ran = 0, clean = 0, refusedOk = 0;
  const only = process.env.GATE_ONLY;
  for (const j of pick()) for (const { name, d } of DIRS) for (const move of ["straight", "left", "right"] as Move[]) {
    const [cx, cy] = center(j), e = move === "straight" ? d : move === "left" ? left(d) : right(d);
    const startOk = Math.abs(cx - 40 * d[0]) <= GRID && Math.abs(cy - 40 * d[1]) <= GRID;
    if (!startOk) continue;                                  // no road to start on: the car cannot be on this approach
    const exitOk = Math.abs(cx + 40 * e[0]) <= GRID && Math.abs(cy + 40 * e[1]) <= GRID;
    const tag = `${center(j).join(",")} ${name} ${move}`;
    if (only && !tag.startsWith(only)) continue;
    const r = pilot(j, d, move);
    ran++;
    if (!exitOk && move !== "straight") {
      if (r.refused && r.collisions === 0) refusedOk++; else (tags.push(tag), bad.push(`${tag}: no street that way, but ${r.refused ? "refused with a collision" : "the turn was accepted"} (collisions ${r.collisions}): ${r.detail.slice(0, 90)}`));
      continue;
    }
    if (!exitOk) continue;                                   // straight on into the edge of the grid: the car is told by STOP/BLOCKED, not asserted here
    if (r.refused || r.collisions || r.red || r.along < 25 || r.lateralErr > 1.6 || r.headingErr > 0.25) {
      (tags.push(tag), bad.push(`${tag}: refused ${r.refused}, collisions ${r.collisions}, red ${r.red}, along ${r.along.toFixed(0)}, lateral err ${r.lateralErr.toFixed(1)}, heading err ${r.headingErr.toFixed(2)}, ${r.steps} steps, car at (${r.x.toFixed(1)}, ${r.z.toFixed(1)}): ${r.detail.slice(0, 120)}`));
    } else clean++;
  }
  console.log(`drive matrix: ${ran} cases, ${clean} clean, ${refusedOk} refused off-grid turns, ${bad.length} bad`);
  if (only || full) { console.log(bad.join("\n")); return; }
  // Known failures, pinned so a fix or a new regression both fail the test and the list gets updated on purpose.
  expect(tags.filter((t) => !KNOWN_BAD.includes(t)), `new failures:\n${bad.join("\n")}`).toEqual([]);
  expect(KNOWN_BAD.filter((t) => !tags.includes(t)), "known failures that now pass: remove them from KNOWN_BAD").toEqual([]);
}, 900_000);

test("with resident traffic running, the back-street start drives north through the first junction at any phase of the traffic", () => {
  const j = JUNCTIONS.find((q) => center(q)[0] === -130 && center(q)[1] === -65)!;
  const green = greenClock(j, [0, 1]);
  for (const warm of [0, 25, 50, 90]) {
    const ambient = new AmbientWorld();
    const service = new WorldService({ sim, nowS: () => green, ambient });
    services.push(service);
    for (let t = 0; t < warm; t += 0.05) service.tick(0.05);
    const car = service.fleet.byId("car-east")!;
    expect(Math.hypot(car.v.x + 128.2, car.v.z + 14)).toBeLessThan(0.5);     // untouched spawn
    service.attach("pilot", { x: car.v.x + 1.8, z: car.v.z, maxR: 3 });
    expect(service.act("pilot", "enter", { type: "enter_vehicle" }).outcome?.ok).toBe(true);
    for (let k = 0; k < 4; k++) {
      service.act("pilot", "d" + k, { type: "drive", speed: 6, heading: 0, seconds: 5 });
      for (let i = 0; i < 600 && !service.actRecord("pilot", "d" + k)?.outcome?.detail; i++) service.tick(0.05);
    }
    expect({ warm, collisions: car.tally.collision, z: Math.round(car.v.z) }).toEqual({ warm, collisions: 0, z: expect.any(Number) });
    expect(car.v.z).toBeLessThan(-70);                                       // through the junction at z -65
    service.detach("pilot");
  }
}, 300_000);

test("a turn out of the grid is refused with the way out; a turn that has a street is accepted", () => {
  const j = JUNCTIONS.find((q) => center(q)[0] === -130 && center(q)[1] === -65)!;   // on the west edge: no street to the west
  const service = new WorldService({ sim, nowS: () => greenClock(j, [0, 1]) });
  services.push(service);
  const car = service.fleet.byId("car-east")!;                                         // the spawn, 51 m south of the junction, facing north
  service.attach("pilot", { x: car.v.x + 1.8, z: car.v.z, maxR: 3 });
  expect(service.act("pilot", "e", { type: "enter_vehicle" }).outcome?.ok).toBe(true);
  const left = service.act("pilot", "l", { type: "drive", speed: 5, turn: "left" }).outcome;
  expect(left?.ok).toBe(false);
  expect(left?.status).toBe("rejected");
  expect(left?.detail).toMatch(/no street to the left.*go straight on or turn right/);
  expect(service.act("pilot", "r", { type: "drive", speed: 5, turn: "right" }).outcome?.ok ?? true).toBe(true);   // east exists: armed, not refused
  expect(car.tally.collision).toBe(0);
  service.detach("pilot");
});
