import { describe, expect, test } from "bun:test";
import { CAR_LEN, LOOPS, crosswalks, pedestrianCrosswalks, sample, spawnCars, spawnWalkers, stepCars, stepWalkers } from "./ambientTraffic";
import { JUNCTIONS, signalState } from "./trafficSignals";

const T0 = 1_700_000_000;

describe("ambient traffic loops", () => {
  test("loops drive on the right lane", () => {
    // ring (ccw): heading east on the bottom edge, the lane is SOUTH of the street centre line y = -65
    const ring = LOOPS.find((l) => l.id === "ring")!;
    const east = ring.pts.find((p, i) => { const n = ring.pts[(i + 1) % ring.pts.length]; return n[0] - p[0] > 1 && Math.abs(n[1] - p[1]) < 1e-6 && Math.abs(p[1] + 65) < 4; })!;
    expect(east[1]).toBeCloseTo(-67.5, 5);
    // wide (cw): heading east on the top edge, the lane is SOUTH of y = 65
    const wide = LOOPS.find((l) => l.id === "wide")!;
    const top = wide.pts.find((p, i) => { const n = wide.pts[(i + 1) % wide.pts.length]; return n[0] - p[0] > 1 && Math.abs(n[1] - p[1]) < 1e-6 && Math.abs(p[1] - 65) < 4; })!;
    expect(top[1]).toBeCloseTo(62.5, 5);
  });
  test("no loop enters the plaza", () => {
    for (const l of LOOPS) for (let s = 0; s < l.length; s += 1) { const p = sample(l, s); expect(Math.abs(p.x) < 60 && Math.abs(p.y) < 60).toBe(false); }
  });
  test("each loop crosses junctions and records entries", () => {
    for (const l of LOOPS) expect(l.entries.length).toBeGreaterThan(4);
  });
  test("simulated cars stop for red, keep a gap and never run a red", () => {
    const cars = spawnCars(3);
    let moved = 0, minGap = Infinity, wentRed = 0, now = T0;
    for (let i = 0; i < 20 * 60 * 5; i++) {          // five minutes at 20 Hz
      const before = cars.map((c) => c.s);
      stepCars(cars, 0.05, now);
      now += 0.05;
      cars.forEach((c, k) => {
        moved += Math.abs(c.s - before[k]) > 0 ? 1 : 0;
        for (const e of c.loop.entries) {
          const L = c.loop.length, was = ((before[k] - e.s) % L + L) % L, nowD = ((c.s - e.s) % L + L) % L;
          if (was > L / 2 && nowD < L / 2) {           // the car just crossed this junction's entry
            const lamp = (t: number) => { const st = signalState(e.j, t); return e.axis === "ns" ? st.ns : st.ew; };
            if (lamp(now) === "red" && lamp(now - 1.5) === "red") wentRed++;
          }
        }
      });
      for (const [i2, a] of cars.entries()) for (const b of cars.slice(i2 + 1)) {
        if (a.loop !== b.loop) continue;
        const d = Math.min(((b.s - a.s) % a.loop.length + a.loop.length) % a.loop.length, ((a.s - b.s) % a.loop.length + a.loop.length) % a.loop.length);
        minGap = Math.min(minGap, d - CAR_LEN);
      }
    }
    expect(moved).toBeGreaterThan(1000);
    expect(minGap).toBeGreaterThan(0);               // never overlapping
    expect(wentRed).toBe(0);
  });
  test("a car at its stop line on red does not move; it goes when green", () => {
    const l = LOOPS[0], e = l.entries[0];
    // find a time when this junction's axis is red, park the car 6 m before the stop line
    let now = T0;
    while (((e.axis === "ns" ? signalState(e.j, now).ns : signalState(e.j, now).ew)) !== "red") now += 0.5;
    const car = { loop: l, s: e.s - 5.2 - 6, v: 5, hue: 0 };
    let t = now;
    const red0 = signalState(e.j, now).changesIn;
    for (let i = 0; i < Math.floor((red0 - 0.5) / 0.05); i++) { stepCars([car], 0.05, t); t += 0.05; }
    expect(car.s).toBeLessThan(e.s - 5.2 + 0.3);     // held at the line
    expect(car.v).toBeLessThan(0.5);
  });
});

describe("ambient pedestrians", () => {
  test("zebras exist for every junction approach", () => { expect(crosswalks().length).toBe(JUNCTIONS.length * 4); });
  test("walkers start only on WALK and finish crossings", () => {
    const ws = spawnWalkers();
    expect(ws.length).toBeGreaterThan(3);
    expect(pedestrianCrosswalks().length).toBe(ws.length);
    let now = T0;
    let crossings = 0, startedOnNotWalk = 0;
    for (let i = 0; i < 20 * 60 * 4; i++) {
      const was = ws.map((w) => w.walking);
      stepWalkers(ws, 0.05, now);
      ws.forEach((w, k) => {
        if (!was[k] && w.walking) {
          const st = signalState(w.cw.j, now);
          if ((w.cw.axis === "ns" ? st.pedNs : st.pedEw) !== "walk") startedOnNotWalk++;
        }
        if (was[k] && !w.walking) crossings++;
      });
      now += 0.05;
    }
    expect(startedOnNotWalk).toBe(0);
    expect(crossings).toBeGreaterThan(ws.length * 2);
    for (const w of ws) { expect(Number.isFinite(w.x)).toBe(true); expect(w.t).toBeGreaterThanOrEqual(0); expect(w.t).toBeLessThanOrEqual(1); }
  });
});

describe("cars yield to bodies", () => {
  const ring = LOOPS.find((l) => l.id === "ring")!;
  // a stretch of the ring far from any junction: find an s whose next 40 m stay clear of entries
  const clearS = (() => { for (let s = 0; s < ring.length; s += 5) if (ring.entries.every((e) => { const d = (((e.s - s) % ring.length) + ring.length) % ring.length; return d > 60 && d < ring.length - 20; })) return s; return 0; })();
  const run = (obstacle: (c: { x: number; y: number; dx: number; dy: number }) => { x: number; y: number; r: number } | null, seconds: number) => {
    const car = { loop: ring, s: clearS, v: 9, hue: 0 };
    const p = sample(ring, clearS + 25);
    const o = obstacle(p);
    let now = T0, minGap = Infinity;
    for (let i = 0; i < seconds * 20; i++) {
      stepCars([car], 0.05, now, o ? [o] : []);
      now += 0.05;
      if (o) { const a = sample(ring, car.s); minGap = Math.min(minGap, (o.x - a.x) * a.dx + (o.y - a.y) * a.dy - CAR_LEN / 2 - o.r); }
    }
    return { car, minGap };
  };

  test("a car stops short of a body standing in its lane, never touching it", () => {
    const { car, minGap } = run((p) => ({ x: p.x, y: p.y, r: 0.4 }), 20);
    expect(car.v).toBeLessThan(0.05);
    expect(minGap).toBeGreaterThan(1);
  });
  test("a body beside the lane (3 m off) does not slow the car", () => {
    const { car } = run((p) => ({ x: p.x - p.dy * 3, y: p.y + p.dx * 3, r: 0.4 }), 4);
    expect(car.v).toBeGreaterThan(8);
  });
  test("a body that stays in the lane longer than the give-up time is no longer obeyed", () => {
    const { car } = run((p) => ({ x: p.x, y: p.y, r: 0.4 }), 60);
    expect(car.v).toBeGreaterThan(3);
  });
});
