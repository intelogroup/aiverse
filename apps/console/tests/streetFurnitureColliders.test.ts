// @vitest-environment node
// The real world-signals.glb / world-roadmarks.glb as walker obstacles: a walker running into a signal post or a sign pole must stop.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildColliders } from "../src/features/world/CameraCollider";
import { solidParts } from "../src/features/world/streetFurniture";
import { createBvhWorld } from "../src/features/world/bvhWorld";
import { makeWalker, step, WALK_CONFIG } from "../src/features/world/walker";

function load(file: string): Promise<THREE.Object3D> {
  const b = readFileSync(new URL(`../public/assets/${file}`, import.meta.url));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Promise((ok, no) => new GLTFLoader().parse(ab as ArrayBuffer, "", (g) => ok(g.scene), no));
}

/** Walk west (heading -pi/2) from x=76 along z for 6 s; returns the final x. */
function walkWest(world: ReturnType<typeof createBvhWorld>, z: number) {
  const s = makeWalker(76, 0.2, z, -Math.PI / 2);
  for (let i = 0; i < 60 * 6; i++) step(s, { forward: 1, strafe: 0, turn: 0, run: true }, 1 / 60, world);
  return s.x;
}

describe("street furniture colliders", async () => {
  const ground = new THREE.Mesh(new THREE.BoxGeometry(60, 1, 60), new THREE.MeshBasicMaterial());
  ground.position.set(70, -0.3, -65); // top at y=0.2 over the (65,65) junction
  const signals = await load("world-signals.glb");
  const marks = await load("world-roadmarks.glb");
  const root = new THREE.Group(); root.add(ground, solidParts(signals), solidParts(marks)); root.updateMatrixWorld(true);
  const solid = createBvhWorld(() => buildColliders(root).meshes);
  const only = new THREE.Group().add(ground.clone()); only.updateMatrixWorld(true);
  const groundOnly = createBvhWorld(() => buildColliders(only).meshes);

  // signals.py: junction x 60..70, y 60..70; the (+1,+1) corner post is at plan (70.8, 70.8) -> three z = -70.8
  it("a signal post at a junction corner stops the walker", () => {
    expect(walkWest(groundOnly, -70.8)).toBeLessThan(62); // control: nothing there without the GLB
    expect(walkWest(solid, -70.8)).toBeGreaterThan(70.8 + 0.07 + WALK_CONFIG.radius - 0.05);
  });

  // roadmarks.py: pedestrian-crossing sign post for the arm south of the same junction, plan (70.7, 55.8)
  it("a sign pole stops the walker", () => {
    expect(walkWest(groundOnly, -55.8)).toBeLessThan(62);
    expect(walkWest(solid, -55.8)).toBeGreaterThan(70.7 + 0.035 + WALK_CONFIG.radius - 0.05);
  });

  // paint is 5 cm proud of the road: it must not become ground the walker steps up onto
  it("road paint is not solid", () => {
    solidParts(marks).traverse((o) => expect(((o as THREE.Mesh).material as THREE.Material | undefined)?.name ?? "").not.toMatch(/^mark_/));
    const world = createBvhWorld(() => buildColliders(root).meshes);
    expect(world.groundY(67, -55.25, 1)).toBeCloseTo(0.2, 3); // on the (65,65) junction's south stop line
  });
});
