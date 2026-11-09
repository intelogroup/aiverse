// @vitest-environment node
import { describe, expect, it } from "vitest";
import { navigationSegment, planRoute, sampleNavigationPatch } from "./navigation";
import type { Vec3, World } from "./walker";
import * as THREE from "three";
import { bakeCollisionRoot, createCapsuleWorld, disposeCollider } from "./capsuleWorld";

type Box = [number, number, number, number];
function world(boxes: Box[] = [], ground: (x: number, z: number) => number | null = () => 0): World {
  return {
    groundY: (x, z, ceiling) => { const y = ground(x, z); return y !== null && y <= ceiling ? y : null; },
    blocked: (_from, to, radius) => boxes.some(([x0, z0, x1, z1]) =>
      to[0] > x0 - radius && to[0] < x1 + radius && to[2] > z0 - radius && to[2] < z1 + radius)
      ? { nx: -1, nz: 0, depth: 0.1 } : null,
  };
}
const options = { halfExtent: 8, cellSize: 0.5, radius: 0.4 };
const start: Vec3 = [0, 0, 0];

describe("collision-derived local navigation", () => {
  it("finds a deterministic route around an inflated stall footprint", () => {
    const w = world([[1, -1, 3, 1]]);
    const route = planRoute(w, start, [5, 0, 0], options);
    expect(route.status).toBe("found");
    expect(route.waypoints.at(-1)).toEqual([5, 0, 0]);
    expect(route.waypoints.some(p => Math.abs(p[2]) >= 1.4)).toBe(true);
    expect(planRoute(w, start, [5, 0, 0], options)).toEqual(route);
    for (let i = 1; i < route.waypoints.length; i++) {
      expect(navigationSegment(w, route.waypoints[i - 1], route.waypoints[i], options)).toBe(true);
    }
  });

  it("rejects a passage narrower than the body's diameter", () => {
    const w = world([[1, -20, 2, -.3], [1, .3, 2, 20]]);
    expect(planRoute(w, start, [4, 0, 0], options).status).toBe("unreachable");
  });

  it("does not diagonal-cut between blocked cardinal neighbours", () => {
    const w = world([[.4, -.1, .6, .1], [-.1, .4, .1, .6]]);
    const route = planRoute(w, start, [.5, 0, .5], { ...options, radius: .1 });
    expect(route.status).toBe("found");
    // A direct diagonal could miss both boxes, but grid edges must respect corner clearance.
    expect(route.waypoints.length).toBeGreaterThan(2);
  });

  it("cannot cross a thin wall or a ground gap", () => {
    expect(navigationSegment(world([[.97, -20, .98, 20]]), start, [2, 0, 0], options)).toBe(false);
    const gap = world([], x => x > 1 && x < 2 ? null : 0);
    expect(planRoute(gap, start, [4, 0, 0], options).status).toBe("unreachable");
  });

  it("climbs successive legal steps but rejects a tall ledge and deep drop", () => {
    const stairs = world([], x => Math.max(0, Math.min(3, Math.floor(x))) * .3);
    expect(planRoute(stairs, start, [4, .9, 0], options).status).toBe("found");
    const ledge = world([], x => x >= 1 ? 1 : 0);
    expect(planRoute(ledge, start, [4, 1, 0], options).status).toBe("unreachable");
    expect(navigationSegment(world([], x => x >= 1 ? -.45 : 0), start, [2, -.45, 0], options)).toBe(false);
  });

  it("requires the goal's floor, rather than claiming arrival below a balcony", () => {
    expect(planRoute(world(), start, [1, 3, 0], options).status).toBe("unreachable");
  });

  it("returns explicit out-of-bounds and budget outcomes without partial success", () => {
    expect(planRoute(world(), start, [9, 0, 0], options)).toMatchObject({ status: "out_of_bounds", waypoints: [], expanded: 0 });
    expect(planRoute(world(), start, [7, 0, 0], { ...options, maxExpansions: 1 })).toMatchObject({ status: "budget_exceeded", waypoints: [], expanded: 1 });
  });

  it("rejects invalid inputs before touching the world", () => {
    const w: World = { groundY: () => { throw Error("must not probe"); }, blocked: () => { throw Error("must not probe"); } };
    for (const settings of [{ cellSize: 0 }, { halfExtent: Infinity }, { maxExpansions: 1e9 }, { radius: 0 }]) {
      expect(planRoute(w, start, [1, 0, 0], settings).status).toBe("invalid");
    }
    expect(planRoute(w, [NaN, 0, 0], [1, 0, 0]).status).toBe("invalid");
  });

  it("publishes reachable heights with bounded size and incomplete budget signal", () => {
    const patch = sampleNavigationPatch(world(), start, { halfExtent: 2, cellSize: 1 });
    expect(patch).toMatchObject({ width: 5, complete: true, origin: [-2, 0, -2] });
    expect(patch.heights).toHaveLength(25);
    expect(patch.heights.every(h => h === 0)).toBe(true);
    expect(sampleNavigationPatch(world(), start, { halfExtent: 2, cellSize: 1, maxExpansions: 1 }).complete).toBe(false);
  });

  it("supports a long bounded route without probing the whole patch", () => {
    let probes = 0;
    const w = world();
    const base = w.groundY;
    w.groundY = (...args) => { probes++; return base(...args); };
    const route = planRoute(w, start, [90, 0, 0], { halfExtent: 128, cellSize: 1, maxExpansions: 10000 });
    expect(route.status).toBe("found");
    expect(route.expanded).toBeLessThan(100);
    expect(probes).toBeLessThan(10000);
  });
});


it("routes around an actual BVH collider using the same capsule world as Scout", () => {
  const root = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.BoxGeometry(30, .2, 30));
  ground.position.y = -.1;
  const stall = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 2));
  stall.position.set(2, 1.5, 0);
  root.add(ground, stall); root.updateMatrixWorld(true);
  const collider = bakeCollisionRoot(root)!;
  try {
    const w = createCapsuleWorld(() => [collider]);
    const route = planRoute(w, start, [5, 0, 0], options);
    expect(route.status).toBe("found");
    expect(route.waypoints.some(p => Math.abs(p[2]) >= 1.4)).toBe(true);
    for (let i = 1; i < route.waypoints.length; i++) {
      expect(w.blocked(route.waypoints[i - 1], route.waypoints[i], .4)).toBeNull();
    }
  } finally {
    disposeCollider(collider); ground.geometry.dispose(); stall.geometry.dispose();
  }
});
