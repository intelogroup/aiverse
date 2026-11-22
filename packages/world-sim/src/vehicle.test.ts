import { describe, expect, test } from "bun:test";
import { JUNCTIONS, STREETS, signalState } from "./trafficSignals";
import { DISC_R, V_LIMIT, V_REV, WHEELBASE, laneError, makeVehicle, stepVehicle, type DriveInput, type Infraction, type VehicleState } from "./vehicle";

const OPEN = { blocked: () => null };
const T0 = 1_700_000_000;
const EAST = Math.PI / 2;

/** Run `seconds` of constant input; collect infractions. */
function drive(v: VehicleState, input: DriveInput, seconds: number, world: Parameters<typeof stepVehicle>[3] = OPEN, now0 = T0): Infraction[] {
  const out: Infraction[] = [];
  for (let t = 0; t < seconds; t += 0.05) out.push(...stepVehicle(v, input, 0.05, world, now0 + t).infractions);
  return out;
}
/** The first junction a car heading east on its street meets, and a clock time at which east-west is red / green. */
function eastApproach(want: "red" | "green") {
  const j = JUNCTIONS.find((q) => q.rect[0] > 60 && Math.abs((q.rect[1] + q.rect[3]) / 2 - 0) < 11)!;   // on the avenue (y = 0), east of the plaza
  for (let t = 0; t < 120; t += 0.5) if (signalState(j, T0 + t).ew === want) return { j, now: T0 + t };
  throw new Error("no such phase");
}

describe("vehicle physics", () => {
  test("gas accelerates, brake stops within the planned distance, and it never reverses", () => {
    const v = makeVehicle(0, 0.2, 0, 0);
    drive(v, { gas: 1, brake: 0, steer: 0 }, 6);
    expect(v.speed).toBeGreaterThan(9);
    const z0 = v.z, s0 = v.speed;
    drive(v, { gas: 0, brake: 1, steer: 0 }, 5);
    expect(v.speed).toBe(0);
    expect(v.z - z0).toBeGreaterThan(s0 * s0 / (2 * 6) * 0.9);
    expect(v.z - z0).toBeLessThan(s0 * s0 / (2 * 6) * 1.15 + 1);
  });
  test("steering follows the bicycle model and left is positive heading", () => {
    const v = makeVehicle(0, 0.2, 0, 0);
    drive(v, { gas: 0.6, brake: 0, steer: 0 }, 3);
    const h0 = v.heading;
    drive(v, { gas: 0.2, brake: 0, steer: 1 }, 1);   // let the wheels settle
    const h1 = v.heading, speed = v.speed, steer = v.steer;
    drive(v, { gas: 0.2, brake: 0, steer: 1 }, 1);
    const rate = (v.heading - h1) / 1;
    expect(h1).toBeGreaterThan(h0);   // left turn raises the heading
    expect(rate).toBeCloseTo(((speed + v.speed) / 2) * Math.tan(v.steer) / WHEELBASE, 1);
    expect(steer).toBeGreaterThan(0.1);
  });
  test("a wall stops the car and reports one collision, then nothing", () => {
    const wall = { blocked: (_f: number[], to: number[]) => (to[2] > 10 ? { nx: 0, nz: -1, depth: 0.1 } : null) };
    const v = makeVehicle(0, 0.2, 0, 0);
    const inf = drive(v, { gas: 1, brake: 0, steer: 0 }, 8, wall as any);
    expect(inf.filter((i) => i.kind === "collision").length).toBe(1);
    expect(v.speed).toBe(0);
    expect(v.z).toBeLessThan(10);
  });
});

describe("rules of the road", () => {
  test("entering a junction on red is one red_light; on green nothing", () => {
    for (const want of ["red", "green"] as const) {
      const { j, now } = eastApproach(want);
      const cy = (j.rect[1] + j.rect[3]) / 2;
      const v = makeVehicle(j.rect[0] - 10, 0.2, -(cy - 2.5), EAST);   // plan y = -z; east lane is the south side
      v.speed = 8;
      const inf = drive(v, { gas: 0.3, brake: 0, steer: 0 }, 3, OPEN, now);
      const red = inf.filter((i) => i.kind === "red_light");
      expect(red.length).toBe(want === "red" ? 1 : 0);
    }
  });
  test("speeding is reported once per excursion after the grace time", () => {
    const v = makeVehicle(-120, 0.2, 0, EAST);
    const inf = drive(v, { gas: 1, brake: 0, steer: 0 }, 10);
    expect(v.speed).toBeGreaterThan(V_LIMIT);
    expect(inf.filter((i) => i.kind === "speeding").length).toBe(1);
  });
  test("driving east on the north side of a street is wrong_lane; on the south side it is not", () => {
    const s = STREETS.find((q) => q.c === 0)!;     // the 20 m avenue
    for (const [side, count] of [[+2.5, 1], [-2.5, 0]] as const) {
      const v = makeVehicle(-200 + 0, 0.2, -(s.c + side), EAST);   // west of everything, on the avenue's line, clear of junctions' rect? see below
      v.x = 70 + 20; v.speed = 6;                                   // a stretch east of the plaza between junctions
      const inf = drive(v, { gas: 0.1, brake: 0, steer: 0 }, 4);
      expect(inf.filter((i) => i.kind === "wrong_lane").length).toBe(count);
    }
  });
  test("laneError: right-hand traffic on all four headings", () => {
    expect(laneError(80, -2.5, EAST)).toBeLessThan(0);       // east, south of the centre line: right side
    expect(laneError(80, 2.5, EAST)).toBeGreaterThan(0);
    expect(laneError(80, 2.5, -EAST)).toBeLessThan(0);       // west keeps north
    expect(laneError(0, 65, 0)).toBeNull();                  // inside a junction rect
    expect(laneError(2.5, 80, 0)).toBeGreaterThan(0);        // south (world +z) keeps west: x > 0 is the wrong side
    expect(laneError(-2.5, 80, 0)).toBeLessThan(0);
    expect(laneError(2.5, 80, Math.PI)).toBeLessThan(0);     // north keeps east
    expect(DISC_R).toBeGreaterThan(0);
  });
});

describe("reverse", () => {
  test("gas with reverse backs the car up slowly, no faster than V_REV, and brake stops it", () => {
    const v = makeVehicle(0, 0.2, 0, EAST);
    drive(v, { gas: 1, brake: 0, steer: 0, reverse: true }, 6);
    expect(v.speed).toBeCloseTo(-V_REV, 5);
    expect(v.x).toBeLessThan(-5);                                  // east-facing car moved west
    drive(v, { gas: 0, brake: 1, steer: 0 }, 2);
    expect(v.speed).toBe(0);                                       // braking ends at rest, it does not roll forward
  });

  test("a car rolling forward brakes before it reverses, and one in reverse stops before it goes forward", () => {
    const v = makeVehicle(0, 0.2, 0, EAST);
    drive(v, { gas: 1, brake: 0, steer: 0 }, 2);
    expect(v.speed).toBeGreaterThan(3);
    drive(v, { gas: 1, brake: 0, steer: 0, reverse: true }, 0.5);
    expect(v.speed).toBeGreaterThanOrEqual(0);
    expect(v.speed).toBeLessThan(3);                               // slowed, not yet flipped
  });

  test("backing into a wall is a blocked step and a collision only when it hits at speed", () => {
    const wall = { blocked: (_f: unknown, to: readonly number[]) => (to[0] < -3 ? ({ point: [0, 0, 0], normal: [1, 0, 0], t: 0 } as never) : null) };
    const v = makeVehicle(0, 0.2, 0, EAST);
    const hits = drive(v, { gas: 1, brake: 0, steer: 0, reverse: true }, 6, wall as never);
    expect(hits.filter((i) => i.kind === "collision").length).toBeLessThanOrEqual(1);
    expect(v.speed).toBe(0);
  });
});

describe("the parked fleet spots", () => {
  test("every PARKED spot is centred in a legal right-hand lane, and car-tea is clear of every ambient loop lane", async () => {
    const { PARKED } = await import("./drive");
    const { LOOPS, sample } = await import("./ambientTraffic");
    const { laneOffset } = await import("./vehicle");
    for (const spot of PARKED) {
      // laneOffset works in plan coords (y = -z): 0 means centred in the lane its heading belongs to
      expect(Math.abs(laneOffset(spot.x, -spot.z, spot.heading) ?? 99), spot.id).toBeLessThan(0.01);
    }
    const tea = PARKED.find((p) => p.id === "car-tea")!;
    let clear = Infinity;
    for (const l of LOOPS) for (let s = 0; s < l.length; s += 0.5) { const p = sample(l, s); clear = Math.min(clear, Math.hypot(p.x - tea.x, p.y + tea.z)); }
    expect(clear).toBeGreaterThan(2.2);   // no resident car's lane comes near it (measured ~58 m: the avenue has no loop)
  });
});
