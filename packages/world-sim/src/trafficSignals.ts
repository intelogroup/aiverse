// Bazaar traffic-signal controller: a pure function of the wall clock, so every viewer, the server sim and the driving
// lab show the same lamp at the same instant, and the signals keep running whether or not anyone is looking.
//
// Real-controller behaviour modelled here:
//  - two-phase pretimed cycle (north-south, east-west) with yellow change and all-red clearance between phases;
//  - splits by street class: the 20 m avenue gets the longer green at its junctions;
//  - coordination: each junction's cycle is offset by its distance from the origin at progression speed, so a platoon
//    driving at that speed meets greens (a "green wave");
//  - pedestrian signals follow the parallel vehicle phase: WALK, then flashing DON'T WALK through the rest of the green
//    and the yellow, then steady DON'T WALK.
// Junction order and rects must match tools/city3/signals.py (signalLamps.json); trafficSignals.test.ts checks it.
export type Lamp = "red" | "yellow" | "green";
export type Ped = "walk" | "flash" | "dont";
export type Axis = "ns" | "ew";

export const STREETS = [{ c: -130, w: 10 }, { c: -65, w: 10 }, { c: 0, w: 20 }, { c: 65, w: 10 }, { c: 130, w: 10 }] as const;
const PLAZA = { x0: -60, y0: -60, x1: 60, y1: 60 };

export const CYCLE = 60;          // s, shared by every junction so offsets stay coordinated
export const YELLOW = 3.5;        // s
export const ALL_RED = 1.5;       // s
export const GREEN_SPLIT_MAJOR = 28;   // s, the avenue's green at an avenue junction
export const GREEN_SPLIT_MINOR = 22;   // s, the side street's green there
export const GREEN_EVEN = 25;          // s each at a junction of two side streets
export const WALK = 7;            // s of WALK at the start of a pedestrian interval
export const PROGRESSION_SPEED = 11;   // m/s (about 25 mph), used for the green wave

export interface Junction {
  id: number;
  rect: [number, number, number, number];   // x0, y0, x1, y1 in plan coords (x east, y north)
  /** Green seconds for the north-south and east-west phases. */
  green: { ns: number; ew: number };
  /** Seconds this junction's cycle starts after the plan origin. */
  offset: number;
}

function buildJunctions(): Junction[] {
  const out: Junction[] = [];
  for (const a of STREETS) {          // a: the road running north-south at x = a.c
    for (const b of STREETS) {        // b: the road running east-west at y = b.c
      const rect: Junction["rect"] = [a.c - a.w / 2, b.c - b.w / 2, a.c + a.w / 2, b.c + b.w / 2];
      const inPlaza = rect[0] >= PLAZA.x0 - 0.01 && rect[1] >= PLAZA.y0 - 0.01 && rect[2] <= PLAZA.x1 + 0.01 && rect[3] <= PLAZA.y1 + 0.01;
      if (inPlaza) continue;
      const green = a.w >= 20 ? { ns: GREEN_SPLIT_MAJOR, ew: GREEN_SPLIT_MINOR }
        : b.w >= 20 ? { ns: GREEN_SPLIT_MINOR, ew: GREEN_SPLIT_MAJOR }
        : { ns: GREEN_EVEN, ew: GREEN_EVEN };
      const along = a.c + b.c;        // grows along either street, so platoons going north or east ride the wave
      out.push({ id: out.length, rect, green, offset: (((along / PROGRESSION_SPEED) % CYCLE) + CYCLE) % CYCLE });
    }
  }
  return out;
}
export const JUNCTIONS: readonly Junction[] = buildJunctions();

export interface SignalState {
  ns: Lamp; ew: Lamp; pedNs: Ped; pedEw: Ped;
  /** Seconds until any lamp of this junction changes. */
  changesIn: number;
}

/** Position in the cycle (s) for a junction at `now` (s). */
function cyclePos(j: Junction, now: number): number {
  return (((now - j.offset) % CYCLE) + CYCLE) % CYCLE;
}

// One phase's timeline: green, yellow, all-red, then the other phase takes over.
function phaseState(t: number, green: number): { lamp: Lamp; elapsed: number } {
  if (t < green) return { lamp: "green", elapsed: t };
  if (t < green + YELLOW) return { lamp: "yellow", elapsed: t - green };
  return { lamp: "red", elapsed: t - green - YELLOW };
}

function ped(lamp: Lamp, elapsed: number): Ped {
  if (lamp === "red") return "dont";
  if (lamp === "yellow") return "flash";
  return elapsed < WALK ? "walk" : "flash";
}

export function signalState(j: Junction, now: number): SignalState {
  const t = cyclePos(j, now);
  const nsEnd = j.green.ns + YELLOW + ALL_RED;          // the ns phase (incl. clearance) ends here
  const ewStart = nsEnd;
  let ns: ReturnType<typeof phaseState>, ew: ReturnType<typeof phaseState>;
  if (t < ewStart) { ns = phaseState(t, j.green.ns); ew = { lamp: "red", elapsed: 0 }; }
  else { ns = { lamp: "red", elapsed: 0 }; ew = phaseState(t - ewStart, j.green.ew); }
  // time to the next boundary of the active phase: end of green, end of yellow, end of clearance
  const bounds = [j.green.ns, j.green.ns + YELLOW, nsEnd, nsEnd + j.green.ew, nsEnd + j.green.ew + YELLOW, CYCLE];
  const next = bounds.find((b) => b > t) ?? CYCLE;
  return { ns: ns.lamp, ew: ew.lamp, pedNs: ped(ns.lamp, ns.elapsed), pedEw: ped(ew.lamp, ew.elapsed), changesIn: next - t };
}

/**
 * Seconds until the lamp of ONE axis changes (green to yellow, yellow to red, red to green). `signalState().changesIn` is the next boundary of
 * the whole junction: a driver reading red with "changes in 0.6 s" took it for green, but 0.6 s was the end of the crossing street's yellow and
 * its 1.5 s all-red still came before its own green (gate census, red light entering junction 12).
 */
export function axisChangesIn(j: Junction, now: number, axis: "ns" | "ew"): number {
  const t = cyclePos(j, now), ewStart = j.green.ns + YELLOW + ALL_RED;
  const start = axis === "ns" ? 0 : ewStart, g = j.green[axis];
  const next = [start, start + g, start + g + YELLOW].map((b) => (b > t ? b : b + CYCLE)).reduce((a, b) => Math.min(a, b));
  return next - t;
}

/** Flash phase of the DON'T WALK hand: on for the first half of each second. */
export function flashOn(now: number): boolean {
  return Math.floor(now * 2) % 2 === 0;
}

/** The junction whose rect contains plan point (x, y), or its nearest within `slack` metres. */
export function junctionAt(x: number, y: number, slack = 0): Junction | null {
  for (const j of JUNCTIONS) {
    const [x0, y0, x1, y1] = j.rect;
    if (x >= x0 - slack && x <= x1 + slack && y >= y0 - slack && y <= y1 + slack) return j;
  }
  return null;
}
