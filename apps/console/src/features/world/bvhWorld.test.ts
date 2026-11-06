// @vitest-environment node
// The walker's BVH world against real three meshes (boxes/planes), then walker.step driving it.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildColliders } from "./CameraCollider";
import { createBvhWorld } from "./bvhWorld";
import { makeWalker, step, WALK_CONFIG } from "./walker";

function scene() {
  const root = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial();
  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, name = "") => {
    const m = new THREE.Mesh(g, mat); m.position.set(x, y, z); m.name = name; root.add(m); return m;
  };
  // Plaza: 40x40 box with its top at y=0.2; a 0.3 m stair block and a 1 m wall; a skipped water slab.
  add(new THREE.BoxGeometry(40, 1, 40), 0, -0.3, 0); // top at 0.2
  add(new THREE.BoxGeometry(4, 0.3, 4), 8, 0.35, 0); // top at 0.5, x 6..10
  add(new THREE.BoxGeometry(0.4, 3, 20), 15, 1.5, 0); // wall x 14.8..15.2
  add(new THREE.BoxGeometry(100, 1, 100), 0, -3, 0, "water_plane"); // must be skipped
  add(new THREE.BoxGeometry(6, 0.3, 6), 0, 5, 12); // overhead deck at y 4.85..5.15 (bridge-like)
  root.updateMatrixWorld(true);
  return buildColliders(root).meshes;
}

describe("bvh world", () => {
  const meshes = scene();
  const world = createBvhWorld(() => meshes);

  it("skips water, finds the plaza and stair tops, ignores decks above", () => {
    expect(meshes.some((m) => m.name === "water_plane")).toBe(false);
    expect(world.groundY(0, 0, 1)).toBeCloseTo(0.2, 4);
    expect(world.groundY(8, 0, 1)).toBeCloseTo(0.5, 4);
    expect(world.groundY(0, 12, 1)).toBeCloseTo(0.2, 4); // deck overhead ignored from y=1
    expect(world.groundY(0, 12, 6)).toBeCloseTo(5.15, 4); // ... but walkable from up there
    expect(world.groundY(30, 0, 1)).toBeNull(); // off the plaza: only skipped water below
  });

  it("reports the wall with a facing normal and penetration", () => {
    const hit = world.blocked([14.3, 0.2, 0], [14.6, 0.2, 0], 0.3);
    expect(hit).not.toBeNull();
    expect(hit!.nx).toBeCloseTo(-1, 3);
    expect(hit!.depth).toBeGreaterThan(0);
    expect(world.blocked([10, 0.2, 0], [10.3, 0.2, 0], 0.3)).toBeNull();
  });

  it("stair risers do not read as walls (rays are above the step-up)", () => {
    expect(world.blocked([5.5, 0.2, 0], [5.8, 0.2, 0], 0.3)).toBeNull();
  });

  it("walker climbs the stair and stops at the wall, running", () => {
    const s = makeWalker(0, 0.2, 0, Math.PI / 2);
    let maxY = 0;
    for (let i = 0; i < 60 * 12; i++) { step(s, { forward: 1, strafe: 0, turn: 0, run: true }, 1 / 60, world); maxY = Math.max(maxY, s.y); }
    expect(maxY).toBeCloseTo(0.5, 3);
    expect(s.y).toBeCloseTo(0.2, 3);
    expect(s.x).toBeLessThanOrEqual(14.8 - WALK_CONFIG.radius + 0.02);
    expect(s.x).toBeGreaterThan(14.0);
  });

  it("slides along the wall at an angle and stays out of it", () => {
    const s = makeWalker(14.2, 0.2, 0, Math.PI / 4);
    for (let i = 0; i < 120; i++) step(s, { forward: 1, strafe: 0, turn: 0, run: false }, 1 / 60, world);
    expect(s.z).toBeGreaterThan(1.5);
    expect(s.x).toBeLessThanOrEqual(14.8 - WALK_CONFIG.radius + 0.02);
  });

  it("does not walk off the plaza edge into the (skipped) water", () => {
    const s = makeWalker(0, 0.2, -10, 0);
    s.heading = Math.PI; // toward -z, edge at z=-20
    for (let i = 0; i < 60 * 15; i++) step(s, { forward: 1, strafe: 0, turn: 0, run: true }, 1 / 60, world);
    expect(s.z).toBeGreaterThan(-20);
    expect(s.y).toBeCloseTo(0.2, 3);
  });
});
