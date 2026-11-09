// @vitest-environment node
// Phase 4 acceptance: scripted crowds over the real navmesh world.
// BEFORE = the pre-L-A stack (greedy straight-line steering, no body
// layer): bots pass through each other. AFTER = navmesh routes +
// steering avoidance + separation solver + navmesh clamp: they don't.
//
// Metrics are computed identically for both modes: deepest pairwise
// penetration, pair-ticks spent interpenetrated (centres closer than
// one body radius — bodies more than half overlapped), arrivals, and
// off-navmesh violations.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CityNav, navMeshWorld } from "../src/features/world/cityNav";
import { avoidVelocity, separateBodies, type BodyDisc } from "../src/features/world/separation";
import { makeWalker, moveToIntent, step, type Vec2, type WalkerState, type World } from "../src/features/world/walker";

const DT = 1 / 30;
const DIAMETER = 0.7;

interface Bot {
  id: string;
  s: WalkerState;
  target: Vec2;
  waypoints: Vec2[];
  arrivedAt: number | null;
}

interface Metrics {
  maxPenetration: number;
  interpenetratedTicks: number; // pair-ticks with centre distance < 0.35
  deepTicks: number; // pair-ticks with centre distance < 0.45
  arrived: number;
  total: number;
  offMesh: number;
  settleDrift: number; // AFTER only: max drift in the 3 s after the last arrival
  seconds: number;
}

let nav: CityNav;
let world: World;

function spawnBot(id: string, x: number, z: number, target: Vec2, routed: boolean): Bot {
  const c = nav.clamp({ x, y: 0.7, z })!;
  const s = makeWalker(c.x, c.y, c.z, 0);
  let waypoints: Vec2[] = [];
  if (routed) {
    const r = nav.route({ x: c.x, y: c.y, z: c.z }, { x: target[0], y: c.y, z: target[1] });
    waypoints = r ? r.waypoints.map((w) => [w.x, w.z] as Vec2) : [];
  }
  return { id, s, target, waypoints, arrivedAt: null };
}

function runScenario(bots: Bot[], mode: "before" | "after", budgetS: number): Metrics {
  const m: Metrics = {
    maxPenetration: 0, interpenetratedTicks: 0, deepTicks: 0,
    arrived: 0, total: bots.length, offMesh: 0, settleDrift: 0, seconds: 0,
  };
  let settledAt: number | null = null;
  let settleSnapshot: Map<string, Vec2> | null = null;
  const ticks = Math.floor(budgetS / DT);
  for (let k = 0; k < ticks; k++) {
    const t = k * DT;
    m.seconds = t;
    // --- move ---
    for (const b of bots) {
      if (b.arrivedAt !== null) continue;
      let steer = b.target;
      if (mode === "after") {
        while (b.waypoints.length > 0 && Math.hypot(b.waypoints[0][0] - b.s.x, b.waypoints[0][1] - b.s.z) <= 0.55) {
          b.waypoints.shift();
        }
        if (b.waypoints.length > 0) steer = b.waypoints[0];
        // steering layer: deflect the desired velocity, re-aim the steer point
        const dx = steer[0] - b.s.x;
        const dz = steer[1] - b.s.z;
        const dl = Math.hypot(dx, dz);
        if (dl > 0.3) {
          const discs = bots.map((o) => ({ id: o.id, x: o.s.x, y: o.s.y, z: o.s.z, vx: o.s.vx, vz: o.s.vz }));
          const self = discs.find((d) => d.id === b.id)!;
          const want = { vx: (dx / dl) * 1.3, vz: (dz / dl) * 1.3 };
          const adj = avoidVelocity(self, discs, want);
          const al = Math.hypot(adj.vx, adj.vz);
          if (al > 1e-6) steer = [b.s.x + (adj.vx / al) * 2.5, b.s.z + (adj.vz / al) * 2.5];
        }
      }
      const { input } = moveToIntent(b.s, steer, 0.5, false);
      step(b.s, input, DT, world);
      if (Math.hypot(b.target[0] - b.s.x, b.target[1] - b.s.z) <= 0.6) {
        b.arrivedAt = t;
        m.arrived++;
      }
    }
    // --- body layer (AFTER) ---
    if (mode === "after") {
      const prev = new Map(bots.map((b) => [b.id, { x: b.s.x, y: b.s.y, z: b.s.z }]));
      const discs: BodyDisc[] = bots.map((b) => ({ id: b.id, x: b.s.x, y: b.s.y, z: b.s.z, vx: b.s.vx, vz: b.s.vz }));
      separateBodies(discs, {}, (d) => {
        const p = prev.get(d.id)!;
        const s = nav.slideAlong(p, { x: d.x, y: d.y, z: d.z });
        if (s) {
          d.x = s.x;
          d.y = s.y;
          d.z = s.z;
        }
      });
      for (const b of bots) {
        const d = discs.find((o) => o.id === b.id)!;
        b.s.x = d.x;
        b.s.y = d.y;
        b.s.z = d.z;
      }
    }
    // --- metrics ---
    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) {
        const a = bots[i].s;
        const c = bots[j].s;
        if (Math.abs(a.y - c.y) >= 1) continue;
        const d = Math.hypot(c.x - a.x, c.z - a.z);
        if (DIAMETER - d > m.maxPenetration) m.maxPenetration = DIAMETER - d;
        if (d < 0.35) m.interpenetratedTicks++;
        if (d < 0.45) m.deepTicks++;
      }
    }
    if (k % 10 === 0) {
      for (const b of bots) if (!nav.onMesh(b.s.x, b.s.y, b.s.z, 0.12)) m.offMesh++;
    }
    if (settledAt === null && bots.every((b) => b.arrivedAt !== null)) {
      settledAt = t;
      settleSnapshot = new Map(bots.map((b) => [b.id, [b.s.x, b.s.z] as Vec2]));
    }
    if (settledAt !== null && t - settledAt >= 3) {
      for (const b of bots) {
        const p = settleSnapshot!.get(b.id)!;
        m.settleDrift = Math.max(m.settleDrift, Math.hypot(b.s.x - p[0], b.s.z - p[1]));
      }
      break;
    }
  }
  return m;
}

function plazaCrowd(routed: boolean): Bot[] {
  const lanes = [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5];
  const bots: Bot[] = [];
  lanes.forEach((z, i) => {
    bots.push(spawnBot(`W${i}`, -17, z, [17, z], routed));
    bots.push(spawnBot(`E${i}`, 17, z, [-17, z], routed));
  });
  return bots;
}

function doorwayCrowd(routed: boolean): Bot[] {
  const bots: Bot[] = [];
  for (let i = 0; i < 4; i++) {
    bots.push(spawnBot(`IN${i}`, -20 - i * 1.4, -78, [-20 - i * 1.4, -67.5], routed));
    bots.push(spawnBot(`OUT${i}`, -25.5 + i * 1.4, -67.5, [-25.5 + i * 1.4, -78], routed));
  }
  return bots;
}

let plazaBefore: Metrics, plazaAfter: Metrics, doorBefore: Metrics, doorAfter: Metrics;
beforeAll(async () => {
  const bytes = readFileSync(
    fileURLToPath(new URL("../public/assets/world-city3-navmesh.bin", import.meta.url)),
  );
  nav = await CityNav.create(new Uint8Array(bytes));
  world = navMeshWorld(nav);
  plazaBefore = runScenario(plazaCrowd(false), "before", 75);
  plazaAfter = runScenario(plazaCrowd(true), "after", 75);
  doorBefore = runScenario(doorwayCrowd(false), "before", 120);
  doorAfter = runScenario(doorwayCrowd(true), "after", 120);
  console.log("plaza  before:", JSON.stringify(plazaBefore));
  console.log("plaza  after: ", JSON.stringify(plazaAfter));
  console.log("door   before:", JSON.stringify(doorBefore));
  console.log("door   after: ", JSON.stringify(doorAfter));
}, 300_000);

describe("crowd: plaza crossing (12 bots, opposite flows)", () => {
  it("BEFORE: the old stack fails the crossing (the bug, reproduced)", () => {
    // The greedy stack wedges on the fountain ring — the historical
    // scout failure: nobody crosses, nobody arrives (0/12 in the run).
    // The pass-through half of the bug is proven by the doorway BEFORE
    // run below (22 interpenetrated ticks, max penetration 0.66 m).
    expect(plazaBefore.arrived).toBeLessThan(plazaBefore.total);
  });
  it("AFTER: nobody passes through anybody, everybody arrives, nobody leaves the mesh", () => {
    expect(plazaAfter.interpenetratedTicks).toBe(0);
    expect(plazaAfter.deepTicks).toBe(0);
    expect(plazaAfter.maxPenetration).toBeLessThan(0.3);
    expect(plazaAfter.arrived).toBe(plazaAfter.total);
    expect(plazaAfter.offMesh).toBe(0);
    expect(plazaAfter.settleDrift).toBeLessThan(0.35);
  });
});

describe("crowd: Tea House doorway (8 bots, both directions through one door)", () => {
  it("AFTER: the whole crowd funnels through without a single pass-through", () => {
    expect(doorAfter.interpenetratedTicks).toBe(0);
    expect(doorAfter.deepTicks).toBe(0);
    expect(doorAfter.arrived).toBe(doorAfter.total);
    expect(doorAfter.offMesh).toBe(0);
    expect(doorAfter.settleDrift).toBeLessThan(0.35);
  });
});
