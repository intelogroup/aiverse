// @vitest-environment node
// The bartender's spot against the SHIPPED Tea House furniture collision: he must stand clear of the counter and the shelves
// (the walker body is 0.4 m; his own collider is 0.22 m) and in front of the bottle shelves, behind the bar, inside the room.
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { bakeCollisionParts, createCapsuleWorld, disposeCollider } from "../src/features/world/capsuleWorld";
import { BARTENDER_COLLIDER, BARTENDER_FLOOR_Y, BARTENDER_PLATFORM_H, BARTENDER_POS } from "../src/features/world/bartender";

const dir = new URL("../public/assets/interiors/", import.meta.url);
const col = JSON.parse(readFileSync(new URL("tea.col.json", dir), "utf8")) as { floorY: number; boxes: number[][] };
const tea = (JSON.parse(readFileSync(new URL("index.json", dir), "utf8")) as { id: string; rect: number[] }[]).find((r) => r.id === "tea")!;
let structural: THREE.Mesh[] = [];
let bar: THREE.Object3D;
beforeAll(async () => {
  globalThis.ProgressEvent ??= class {} as typeof ProgressEvent;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  loader.register(() => ({ name: "testMaterials", loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })) }));
  const bytes = readFileSync(new URL("../public/assets/world-city3-collision.glb", import.meta.url));
  const scene = (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset+bytes.byteLength), "")).scene;
  scene.updateMatrixWorld(true);bar = scene.getObjectByName("col_tea_G_bar")!;
  structural = bakeCollisionParts(scene);
});
afterAll(() => structural.forEach(disposeCollider));

/** Distance from a point to an axis-aligned (rot 0 / pi) or rotated box footprint. */
function dist(b: number[], x: number, z: number) {
  const [cx, cz, hx, hz, , , rot] = b;
  const dx = x - cx;
  const dz = z - cz;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.hypot(Math.max(Math.abs(lx) - hx, 0), Math.max(Math.abs(lz) - hz, 0));
}

describe("bartender placement in the shipped Tea House", () => {
  it("stands on the room floor, inside the room", () => {
    expect(BARTENDER_FLOOR_Y).toBe(col.floorY);
    const [x0, z0, x1, z1] = tea.rect;
    expect(BARTENDER_POS[0]).toBeGreaterThan(x0 + 1);
    expect(BARTENDER_POS[0]).toBeLessThan(x1 - 1);
    expect(BARTENDER_POS[1]).toBeGreaterThan(z0 + 0.6);
    expect(BARTENDER_POS[1]).toBeLessThan(z1 - 1);
  });

  it("his collider (body + duckboard) clears every furniture box by >= 5 cm, and the duckboard fits the bar corridor", () => {
    const [cx, cz, hx, hz] = BARTENDER_COLLIDER;
    const probes: [number, number][] = [];
    for (const fx of [-1, -0.5, 0, 0.5, 1]) for (const fz of [-1, -0.5, 0, 0.5, 1]) probes.push([cx + fx * hx, cz + fz * hz]);
    const d = Math.min(...col.boxes.flatMap((b) => probes.map(([x, z]) => dist(b, x, z))));
    expect(d).toBeGreaterThanOrEqual(0.05);
    const world = createCapsuleWorld(() => structural);
    expect(world.blocked([cx,BARTENDER_FLOOR_Y,cz],[cx,BARTENDER_FLOOR_Y,cz],.35)).toBeNull();
    expect(BARTENDER_PLATFORM_H).toBeLessThan(0.5); // a board, not a stage
  });

  it("has the actual built counter between him and the customer area", () => {
    expect(bar).toBeDefined();
    const ray = new THREE.Raycaster(new THREE.Vector3(BARTENDER_POS[0],1.3,BARTENDER_POS[1]),new THREE.Vector3(0,0,1),0,2);
    expect(ray.intersectObject(bar,true)[0]?.distance).toBeCloseTo(.36,2);
  });
});
