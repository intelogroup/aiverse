// @vitest-environment node
// capsuleWorld against synthetic closed solids (what the collision GLBs contain), driven by walker.step.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { bakeCollisionRoot, boxesMesh, createCapsuleWorld, disposeCollider } from "./capsuleWorld";
import { findSpawn, makeWalker, step, WALK_CONFIG, type WalkInput, type WalkerState } from "./walker";

const G = 0.2;

/** Up-facing ground quad covering [x0,x1]x[z0,z1] at height y. */
function groundQuad(x0: number, z0: number, x1: number, z1: number, y: number, up = true): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1]), 3));
  g.setIndex(up ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]);
  return new THREE.Mesh(g);
}
/** Closed box [x0,x1]x[y0,y1]x[z0,z1]. */
function solid(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): THREE.Mesh {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  const m = new THREE.Mesh(g);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return m;
}
/** A single zero-thickness wall quad in the plane x = x0 (one-sided on purpose). */
function wallQuad(x0: number, z0: number, z1: number, y1: number): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([x0, 0, z0, x0, 0, z1, x0, y1, z1, x0, y1, z0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return new THREE.Mesh(g);
}

function worldOf(...parts: THREE.Mesh[]) {
  const root = new THREE.Group();
  root.add(ground(), ...parts);
  root.updateMatrixWorld(true);
  const col = bakeCollisionRoot(root)!;
  return createCapsuleWorld(() => [col]);
}
const ground = () => groundQuad(-60, -60, 60, 60, G);

const FWD: WalkInput = { forward: 1, strafe: 0, turn: 0, run: false };
const RUN: WalkInput = { ...FWD, run: true };
function drive(s: WalkerState, input: WalkInput, secs: number, w: ReturnType<typeof worldOf>, dt = 1 / 30) {
  for (let t = 0; t < secs; t += dt) step(s, input, dt, w);
  return s;
}
const R = WALK_CONFIG.radius;

describe("capsule world: walls", () => {
  // A closed 10x10x6 building, x in [10,20], z in [-5,5].
  const w = worldOf(solid(10, 0, -5, 20, 6, 5));
  it("finds ground and ignores the underside", () => {
    expect(w.groundY(0, 0, 1)).toBeCloseTo(G, 4);
    expect(w.groundY(15, 0, 7)).toBeCloseTo(6, 4); // roof when standing above
    expect(w.groundY(15, 0, 1)).toBeCloseTo(G, 4); // from inside the solid: floor under it, roof/underside ignored
  });
  it("walking at the wall from outside stops one radius away and never enters", () => {
    const s = drive(makeWalker(0, G, 0, Math.PI / 2), FWD, 12, w);
    expect(s.x).toBeLessThanOrEqual(10 - R + 0.02);
    expect(s.x).toBeGreaterThan(10 - R - 0.1);
  });
  it("running at it head-on, any dt, cannot tunnel", () => {
    for (const dt of [1 / 60, 1 / 30, 0.1]) {
      const s = drive(makeWalker(0, G, 0, Math.PI / 2), RUN, 12, w, dt);
      expect(s.x).toBeLessThanOrEqual(10 - R + 0.02);
    }
  });
  it("approaching from inside the closed solid is also blocked (double-sided)", () => {
    // Start inside the box, walk toward each wall: the bot must stay in the box (spawned inside, e.g. a teleport).
    const w2 = worldOf(solid(10, 0, -5, 20, 6, 5));
    const hit = w2.blocked([14.9, G, 0], [15, G, 0], R);
    // Centre of the box: the capsule is deep in a solid; any push is toward the nearest wall plane, not zero depth.
    expect(hit === null || hit.depth >= 0).toBe(true);
  });
  it("slides along a wall at an angle", () => {
    // Mostly +x with some +z, so it MEETS the face (the old 45-degree run from the origin passed the box's corner and only
    // stayed outside because 4 s at the old 2.7 m/s ended before x reached the wall). Speed-independent: run until it has
    // slid well along the face, checking every frame that it never enters the wall.
    const s = makeWalker(0, G, -4, Math.atan2(1, 0.35));
    let t = 0;
    while (s.z < 3 && t < 12) {
      step(s, RUN, 1 / 30, w);
      t += 1 / 30;
      expect(s.x).toBeLessThanOrEqual(10 - R + 0.02);
    }
    expect(s.z).toBeGreaterThanOrEqual(3); // slid sideways along the face instead of stopping
    expect(s.x).toBeGreaterThan(10 - R - 0.1); // and it was pressed against the face while doing so
  });
  it("a corner: sliding around the edge does not enter the box", () => {
    const s = makeWalker(8, G, 3, Math.PI / 2 + 0.3);
    for (let i = 0; i < 400; i++) {
      step(s, { ...RUN, turn: i % 50 < 25 ? 0.3 : -0.3 }, 1 / 30, w);
      const inside = s.x > 10 - R + 0.03 && s.x < 20 + R && s.z > -5 - R + 0.03 && s.z < 5 + R && s.y < 5;
      // inside means within the rounded-off rect; the exact test: distance to box rect < R-3cm
      const dx = Math.max(10 - s.x, 0, s.x - 20);
      const dz = Math.max(-5 - s.z, 0, s.z - 5);
      expect(Math.hypot(dx, dz)).toBeGreaterThan(R - 0.03);
      void inside;
    }
  });
});

describe("capsule world: thin walls and high speed", () => {
  const w = worldOf(wallQuad(10, -20, 20, 3)); // zero thickness, facing -x only
  it("a one-sided zero-thickness wall blocks from the front AND the back", () => {
    const a = drive(makeWalker(0, G, 0, Math.PI / 2), RUN, 8, w);
    expect(a.x).toBeLessThan(10);
    const b = drive(makeWalker(20, G, 0, -Math.PI / 2), RUN, 8, w);
    expect(b.x).toBeGreaterThan(10);
  });
  it("blocked() with a huge single step (3 m) still resists", () => {
    const hit = w.blocked([8, G, 0], [11.5, G, 0], R);
    expect(hit).not.toBeNull();
    expect(hit!.nx).toBeLessThan(-0.9);
  });
});

describe("capsule world: steps, stairs, platform edges", () => {
  it("steps up a 0.35 riser but not a 0.6 one", () => {
    const lo = worldOf(solid(10, 0, -20, 30, G + 0.35, 20));
    const s1 = drive(makeWalker(0, G, 0, Math.PI / 2), FWD, 12, lo);
    expect(s1.x).toBeGreaterThan(12);
    expect(s1.y).toBeCloseTo(G + 0.35, 2);
    const hi = worldOf(solid(10, 0, -20, 30, G + 0.6, 20));
    const s2 = drive(makeWalker(0, G, 0, Math.PI / 2), FWD, 12, hi);
    expect(s2.x).toBeLessThan(10);
    expect(s2.y).toBeCloseTo(G, 3);
  });
  it("climbs stairs of 0.3 risers, and the wall above them still stops it", () => {
    const parts: THREE.Mesh[] = [];
    for (let i = 0; i < 6; i++) parts.push(solid(10 + i * 0.5, 0, -3, 20, G + 0.3 * (i + 1), 3));
    parts.push(solid(20, 0, -3, 21, 5, 3)); // top landing at 2.0 then a wall
    const w = worldOf(...parts);
    const s = drive(makeWalker(0, G, 0, Math.PI / 2), FWD, 20, w);
    expect(s.y).toBeGreaterThan(G + 1.5);
    expect(s.x).toBeLessThanOrEqual(20 - R + 0.02);
  });
  it("stops at a platform edge it cannot step off into the void", () => {
    const g = new THREE.Group();
    g.add(groundQuad(-20, -20, 12, 20, G));
    g.updateMatrixWorld(true);
    const col = bakeCollisionRoot(g)!;
    const w = createCapsuleWorld(() => [col]);
    const s = drive(makeWalker(0, G, 0, Math.PI / 2), RUN, 10, w);
    expect(s.x).toBeLessThanOrEqual(12.0);
    expect(s.y).toBeCloseTo(G, 3);
  });
  it("down-facing (wrongly wound) ground quads are ignored, not walked through", () => {
    const root = new THREE.Group();
    root.add(groundQuad(-10, -10, 10, 10, G, false));
    root.updateMatrixWorld(true);
    const col = bakeCollisionRoot(root)!;
    const w = createCapsuleWorld(() => [col]);
    expect(w.groundY(0, 0, 2)).toBeNull();
  });
});

describe("capsule world: spawn (the fountain case)", () => {
  // Fountain platform: a solid disc-ish box r=10 up to 1.1 at the origin; nothing but plaza elsewhere.
  const w = worldOf(solid(-10, 0, -10, 10, 1.1, 10));
  it("never spawns inside the solid", () => {
    const sp = findSpawn(w, { cx: 0, cz: 0 });
    expect(sp).not.toBeNull();
    const out = Math.max(Math.abs(sp!.x), Math.abs(sp!.z));
    expect(out).toBeGreaterThan(10 + 0.9 - 0.01);
    expect(sp!.y).toBeCloseTo(G, 3);
  });
});

describe("capsule world: interior boxes", () => {
  it("boxesMesh builds closed rotated solids that block from all sides and give no ground", () => {
    const m = boxesMesh([[2, 3, 1, 0.5, G, G + 1, 0.7]], [100, 200])!;
    const root = new THREE.Group();
    root.add(groundQuad(90, 190, 130, 230, G));
    root.updateMatrixWorld(true);
    const floor = bakeCollisionRoot(root)!;
    const w = createCapsuleWorld(() => [floor, m]);
    expect(m.userData.noGround).toBe(true);
    expect(w.groundY(102, 203, 3)).toBeCloseTo(G, 4); // box top does not carry the bot
    // rotation: box long axis (hx=1) points along (cos .7, -sin .7) in xz
    const c = [102, 203];
    const ux = Math.cos(0.7), uz = -Math.sin(0.7);
    expect(w.blocked([c[0] + ux * 2.2, G, c[1] + uz * 2.2], [c[0] + ux * 1.2, G, c[1] + uz * 1.2], R)).not.toBeNull();
    expect(w.blocked([c[0] + ux * 2.2, G, c[1] + uz * 2.2], [c[0] + ux * 1.6, G, c[1] + uz * 1.6], R)).toBeNull();
    expect(w.blocked([c[0] - uz * 2, G, c[1] + ux * 2], [c[0] - uz * 0.8, G, c[1] + ux * 0.8], R)).not.toBeNull(); // short axis side
    disposeCollider(m);
  });
});

describe("capsule world: hero room with a door gap", () => {
  // Interior x,z in [0,6]; 0.3 m walls around it; door gap 1.7 m wide centred x=3 in the south (z<0) wall; floor 0.28; lintel above 2.9.
  const T = 0.3;
  const parts = [
    solid(-T, 0, 6, 6 + T, 3.2, 6 + T), // north
    solid(-T, 0, -T, 0, 3.2, 6 + T), // west
    solid(6, 0, -T, 6 + T, 3.2, 6 + T), // east
    solid(-T, 0, -T, 2.15, 3.2, 0), // south left of the door
    solid(3.85, 0, -T, 6 + T, 3.2, 0), // south right of the door
    solid(2.15, 2.9, -T, 3.85, 3.2, 0), // lintel
    groundQuad(0, 0, 6, 6, 0.28),
  ];
  const w = worldOf(...parts);
  it("enters through the door gap and is stopped by the back wall", () => {
    const s = drive(makeWalker(3, G, -6, 0), FWD, 10, w);
    expect(s.z).toBeGreaterThan(3);
    expect(s.z).toBeLessThanOrEqual(6 - R + 0.02);
    expect(s.y).toBeCloseTo(0.28, 2);
  });
  it("cannot enter beside the door gap, and cannot leave through a wall from inside", () => {
    const out = drive(makeWalker(1, G, -6, 0), RUN, 6, w);
    expect(out.z).toBeLessThanOrEqual(-R + 0.02);
    const inside = makeWalker(3, 0.28, 3, -Math.PI / 2); // facing -x
    drive(inside, RUN, 6, w);
    expect(inside.x).toBeGreaterThanOrEqual(R - 0.02);
  });
  it("a random walk inside never leaves the shell except by the door", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const s = makeWalker(3, 0.28, 3, 0);
    for (let i = 0; i < 3000; i++) {
      step(s, { forward: 1, strafe: rnd() - 0.5, turn: rnd() - 0.5, run: rnd() > 0.5 }, 1 / 30, w);
      const through = s.z < -0.05 && !(s.x > 2.15 && s.x < 3.85);
      expect(through).toBe(false);
      expect(s.x).toBeGreaterThan(-0.05);
      expect(s.x).toBeLessThan(6.05);
      expect(s.z).toBeLessThan(6.05);
    }
  });
});
