// Ambient Bazaar traffic: cars on closed loops of the street grid that obey the shared signal controller, and pedestrians
// who cross at the zebras only on WALK. Everything is plan coordinates (x east, y north); the console maps y to three z = -y.
//
// Shortcuts (ambient dressing, not a traffic model): cars never leave their loop, so conflicts exist only where two loops
// cross, and those happen at signalled junctions; a car that is past its stop line when the light turns runs through;
// cars follow only the car ahead on their own loop; nothing reacts to the player.
import { JUNCTIONS, signalState, type Axis, type Junction, type Lamp, type Ped } from "./trafficSignals";

export const LANE = 2.5;            // lane centre from the street centre line (10 m streets)
export const CAR_LEN = 4.6;
export const MIN_GAP = 2.5;         // bumper gap a stopped car keeps
export const STOP_BACK = 5.2;       // stop line distance before the junction edge (roadmarks.py: 4.5-5.0 m, zebra 1.5-4.0 m)
export const V_MAX = 11;            // m/s, the signal progression speed
const ACCEL = 2.4;
const BRAKE = 3.2;                  // comfortable braking: stop decisions are planned with it
const BRAKE_MAX = 6;                // what the car may actually shed per second, so it can hold the plan

export type Pt = readonly [number, number];
export interface Entry { s: number; sExit: number; j: Junction; axis: Axis }
export interface Loop { id: string; pts: Pt[]; cum: number[]; length: number; entries: Entry[] }

/** Rectangular loop through street centre lines xa..xb, ya..yb, right-hand lanes, corners filleted at radius LANE.
 *  ccw = outer lane of each street (bottom edge south of its line); clockwise = the inner lane of the same streets. */
function rectLoop(id: string, xa: number, xb: number, ya: number, yb: number, ccw: boolean): Loop {
  const corners: Pt[] = ccw
    ? [[xb + LANE, ya - LANE], [xb + LANE, yb + LANE], [xa - LANE, yb + LANE], [xa - LANE, ya - LANE]]
    : [[xa + LANE, yb - LANE], [xb - LANE, yb - LANE], [xb - LANE, ya + LANE], [xa + LANE, ya + LANE]];
  const pts: Pt[] = [];
  const n = corners.length;
  for (let k = 0; k < n; k++) {
    const prev = corners[(k + n - 1) % n], P = corners[k], next = corners[(k + 1) % n];
    const d1 = unit(prev, P), d2 = unit(P, next);
    const A: Pt = [P[0] - d1[0] * LANE, P[1] - d1[1] * LANE];
    const C: Pt = [A[0] + d2[0] * LANE, A[1] + d2[1] * LANE];
    for (let q = 0; q <= 8; q++) {
      const th = (q / 8) * (Math.PI / 2);
      pts.push([C[0] + (A[0] - C[0]) * Math.cos(th) + d1[0] * LANE * Math.sin(th), C[1] + (A[1] - C[1]) * Math.cos(th) + d1[1] * LANE * Math.sin(th)]);
    }
  }
  return finish(id, pts);
}

function unit(a: Pt, b: Pt): Pt { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; }

function finish(id: string, pts: Pt[]): Loop {
  const cum = [0];
  for (let i = 1; i <= pts.length; i++) {
    const a = pts[i - 1], b = pts[i % pts.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const loop: Loop = { id, pts, cum, length: cum[pts.length], entries: [] };
  loop.entries = findEntries(loop);
  return loop;
}

/** Position and heading (atan2(dx, dz) in three space: 0 faces +z = plan -y) at arclength s. */
export function sample(loop: Loop, s: number): { x: number; y: number; dx: number; dy: number } {
  const L = loop.length;
  s = ((s % L) + L) % L;
  let lo = 0, hi = loop.pts.length;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (loop.cum[m] <= s) lo = m; else hi = m; }
  const a = loop.pts[lo], b = loop.pts[(lo + 1) % loop.pts.length];
  const len = loop.cum[lo + 1] - loop.cum[lo] || 1;
  const t = (s - loop.cum[lo]) / len;
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, dx: (b[0] - a[0]) / len, dy: (b[1] - a[1]) / len };
}

function inRect(x: number, y: number, r: Junction["rect"]): boolean { return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]; }

/** Where the loop enters and leaves each junction rect, with the travel axis on entry. */
function findEntries(loop: Loop): Entry[] {
  const out: Entry[] = [];
  const STEP = 0.25;
  for (const j of JUNCTIONS) {
    let inside = false, start = 0, axis: Axis = "ns";
    // start just outside any junction: walk one full lap, handling a junction that spans the lap origin
    const first = sample(loop, 0);
    const startInside = inRect(first.x, first.y, j.rect);
    let s = 0;
    for (; s <= loop.length; s += STEP) {
      const p = sample(loop, s);
      const now = inRect(p.x, p.y, j.rect);
      if (now && !inside) { inside = true; start = s; axis = Math.abs(p.dx) > Math.abs(p.dy) ? "ew" : "ns"; }
      else if (!now && inside) { inside = false; out.push({ s: start, sExit: s, j, axis }); }
    }
    if (inside && !startInside) out.push({ s: start, sExit: loop.length, j, axis });
  }
  return out.sort((a, b) => a.s - b.s);
}

/** Four loops whose lanes never share a direction, so cars on different loops meet only at signalled crossings. */
export const LOOPS: readonly Loop[] = [
  rectLoop("ring", -65, 65, -65, 65, true),
  rectLoop("outer", -130, 130, -130, 130, true),
  rectLoop("wide", -130, 130, -65, 65, false),
  rectLoop("tall", -65, 65, -130, 130, false),
];

export interface Car { loop: Loop; s: number; v: number; hue: number }

/** `perLoop` cars on each loop, evenly spaced with a per-loop phase. */
export function spawnCars(perLoop = 2): Car[] {
  const cars: Car[] = [];
  LOOPS.forEach((loop, li) => {
    for (let k = 0; k < perLoop; k++) {
      let s = ((k + 0.37 * (li + 1)) / perLoop) * loop.length;
      // never start inside a junction or the braking zone before one
      const bad = (x: number) => loop.entries.some((e) => { const r = ((x - e.s + loop.length / 2) % loop.length + loop.length) % loop.length - loop.length / 2; return r > -STOP_BACK - 14 && r < e.sExit - e.s + 2; });
      for (let g = 0; g < 400 && bad(s); g++) s = (s + 1) % loop.length;
      cars.push({ loop, s, v: 0, hue: (li * perLoop + k) / (LOOPS.length * perLoop) });
    }
  });
  return cars;
}

function lampFor(e: Entry, now: number): Lamp { const st = signalState(e.j, now); return e.axis === "ns" ? st.ns : st.ew; }

/** Speed ceiling from the next signal on the car's path (Infinity when nothing holds it). */
export function signalLimit(car: Car, now: number): number {
  const L = car.loop.length;
  let best = Infinity;
  for (const e of car.loop.entries) {
    const rel = ((car.s - e.s + L / 2) % L + L) % L - L / 2;   // signed distance past the junction entry
    const d = -rel - STOP_BACK;                                  // distance to the stop line; < 0 once past it
    if (d < -0.8 || d > 80) continue;                            // clearly past the line (go on through) or too far to matter
    const lamp = lampFor(e, now);
    if (lamp === "green") continue;
    const canStop = (car.v * car.v) / (2 * BRAKE) <= d;
    if (lamp === "yellow" && !canStop) continue;               // too late to stop: clear the junction
    best = Math.min(best, Math.sqrt(2 * BRAKE * Math.max(d - 0.2, 0)));
  }
  return best;
}

/** Advance all cars by dt seconds at wall-clock time `now` (seconds). Mutates `cars`. */
export function stepCars(cars: Car[], dt: number, now: number): void {
  const byLoop = new Map<Loop, Car[]>();
  for (const c of cars) { const a = byLoop.get(c.loop) ?? []; a.push(c); byLoop.set(c.loop, a); }
  for (const [loop, list] of byLoop) {
    list.sort((a, b) => a.s - b.s);
    const n = list.length;
    const target = list.map((c, i) => {
      let t = Math.min(V_MAX, signalLimit(c, now));
      if (n > 1) {
        const lead = list[(i + 1) % n];
        const gap = ((lead.s - c.s) % loop.length + loop.length) % loop.length - CAR_LEN;
        t = Math.min(t, Math.sqrt(2 * BRAKE * Math.max(gap - MIN_GAP, 0)) + (gap > MIN_GAP ? 0 : 0));
      }
      return t;
    });
    list.forEach((c, i) => {
      c.v += Math.max(-BRAKE_MAX * dt, Math.min(ACCEL * dt, target[i] - c.v));
      if (c.v < 0.01 && target[i] < 0.01) c.v = 0;
      c.s = (c.s + c.v * dt) % loop.length;
    });
  }
}

// ---------------------------------------------------------------- pedestrians

export interface Crosswalk { j: Junction; a: Pt; b: Pt; axis: Axis }

/** Zebra mid-line 2.75 m outside a junction edge; `axis` is the phase that is parallel to the walker (the one it follows). */
export function crosswalks(): Crosswalk[] {
  const out: Crosswalk[] = [];
  const CURB = 0.9;     // wait this far beyond the kerb
  const MID = 2.75;
  for (const j of JUNCTIONS) {
    const [x0, y0, x1, y1] = j.rect;
    out.push({ j, axis: "ns", a: [x0 - MID, y0 - CURB], b: [x0 - MID, y1 + CURB] });   // west zebra: walk north-south
    out.push({ j, axis: "ns", a: [x1 + MID, y0 - CURB], b: [x1 + MID, y1 + CURB] });   // east zebra
    out.push({ j, axis: "ew", a: [x0 - CURB, y0 - MID], b: [x1 + CURB, y0 - MID] });   // south zebra: walk east-west
    out.push({ j, axis: "ew", a: [x0 - CURB, y1 + MID], b: [x1 + CURB, y1 + MID] });   // north zebra
  }
  return out;
}

/** The zebras the ambient pedestrians use: the ring streets round the plaza (x or y = +-65, x or y = 0 side). */
export function pedestrianCrosswalks(): Crosswalk[] {
  const want = [[65, 0, "east"], [-65, 0, "west"], [0, 65, "north"], [0, -65, "south"], [65, 65, "east"], [-65, -65, "west"]] as const;
  const all = crosswalks();
  const picks: Crosswalk[] = [];
  for (const [cx, cy, side] of want) {
    const j = JUNCTIONS.find((q) => Math.abs((q.rect[0] + q.rect[2]) / 2 - cx) < 1 && Math.abs((q.rect[1] + q.rect[3]) / 2 - cy) < 1);
    if (!j) continue;
    const mine = all.filter((c) => c.j === j);
    // the walk across the street that leads away from the plaza centre
    const pick = side === "east" ? mine.find((c) => c.axis === "ns" && c.a[0] > j.rect[2])
      : side === "west" ? mine.find((c) => c.axis === "ns" && c.a[0] < j.rect[0])
      : side === "north" ? mine.find((c) => c.axis === "ew" && c.a[1] > j.rect[3])
      : mine.find((c) => c.axis === "ew" && c.a[1] < j.rect[1]);
    if (pick) picks.push(pick);
  }
  return picks;
}

export const PED_SPEED = 1.4;

export interface Walker { cw: Crosswalk; t: number; dir: 1 | -1; walking: boolean; x: number; y: number; heading: number; moving: boolean }

export function spawnWalkers(): Walker[] {
  return pedestrianCrosswalks().map((cw, i) => ({ cw, t: i % 2 ? 1 : 0, dir: i % 2 ? -1 : 1, walking: false, x: 0, y: 0, heading: 0, moving: false }));
}

function pedFor(c: Crosswalk, now: number): Ped { const st = signalState(c.j, now); return c.axis === "ns" ? st.pedNs : st.pedEw; }

/** Advance walkers: wait at the kerb, step off only on WALK, finish the crossing whatever the signal does. Mutates `ws`. */
export function stepWalkers(ws: Walker[], dt: number, now: number): void {
  for (const w of ws) {
    const len = Math.hypot(w.cw.b[0] - w.cw.a[0], w.cw.b[1] - w.cw.a[1]);
    if (!w.walking && pedFor(w.cw, now) === "walk") w.walking = true;
    w.moving = w.walking;
    if (w.walking) {
      w.t += (w.dir * PED_SPEED * dt) / len;
      if (w.t >= 1 || w.t <= 0) { w.t = w.t >= 1 ? 1 : 0; w.dir = w.dir === 1 ? -1 : 1; w.walking = false; w.moving = false; }
    }
    w.x = w.cw.a[0] + (w.cw.b[0] - w.cw.a[0]) * w.t;
    w.y = w.cw.a[1] + (w.cw.b[1] - w.cw.a[1]) * w.t;
    // three heading = atan2(dx, dz) with dz = -dy
    const dx = (w.cw.b[0] - w.cw.a[0]) * w.dir, dy = (w.cw.b[1] - w.cw.a[1]) * w.dir;
    w.heading = Math.atan2(dx, -dy);
  }
}
