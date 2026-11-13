// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import type { EggPlacement } from "../src/features/world/EasterEggs";

const assets = new URL("../public/", import.meta.url);
const read = (path: string) => readFileSync(new URL(`.${path}`, assets));
const manifest = JSON.parse(read("/assets/collectibles/easter-eggs.json").toString()) as { contestActive: boolean; model: string; eggs: EggPlacement[] };
const districts = JSON.parse(read("/assets/districts.json").toString()).districts as { id: string; url: string; center: [number, number]; half: number }[];
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
// The tests need shipped geometry; skip image decoding so the real assets load in Node.
loader.register(() => ({ name: "test-materials", loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })) }));
async function load(path: string) {
  const bytes = read(path);
  return (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "")).scene;
}

describe("shipped Easter eggs", () => {
  it("has stable unique IDs in every district, without enabling a contest", () => {
    expect(manifest.contestActive).toBe(false);
    expect(new Set(manifest.eggs.map(egg => egg.id)).size).toBe(districts.length * 6);
    for (const district of districts) {
      const eggs = manifest.eggs.filter(egg => egg.district === district.id);
      expect(eggs).toHaveLength(6);
      for (const egg of eggs) {
        expect(egg.id).toMatch(new RegExp(`^egg-${district.id}-\\d{2}$`));
        expect(Math.abs(egg.position[0] - district.center[0])).toBeLessThan(district.half);
        expect(Math.abs(egg.position[2] - district.center[1])).toBeLessThan(district.half);
        expect(egg.scale).toBeGreaterThan(0);
      }
    }
  });

  it("retains vertex colors in a grounded, browser-sized source model", async () => {
    const model = await load(manifest.model);
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model);
    expect(bounds.min.y).toBeCloseTo(0, 5);
    expect(bounds.max.y).toBeCloseTo(.5, 5);
    let triangles = 0;
    model.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      expect(mesh.geometry.getAttribute("color")).toBeDefined();
      triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position").count) / 3;
      // The source arrives split into chunks. Guard against simplifying those seams into holes.
      const points = mesh.geometry.getAttribute("position");
      const unique = new Map<string, number>();
      const vertices: number[] = [];
      for (let i = 0; i < points.count; i++) {
        const key = [points.getX(i), points.getY(i), points.getZ(i)].map(v => v.toFixed(6)).join(",");
        if (!unique.has(key)) unique.set(key, unique.size);
        vertices.push(unique.get(key)!);
      }
      const index = mesh.geometry.index;
      const edges = new Map<string, number>();
      for (let i = 0; i < (index?.count ?? points.count); i += 3) {
        const face = [0, 1, 2].map(j => vertices[index ? index.getX(i + j) : i + j]);
        for (let j = 0; j < 3; j++) {
          const a = face[j], b = face[(j + 1) % 3];
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      expect([...edges.values()].every(count => count === 2), "egg surface must remain closed after seam welding").toBe(true);
    });
    expect(triangles).toBeGreaterThan(0);
    expect(triangles).toBeLessThanOrEqual(10000);
    expect(read(manifest.model).length).toBeLessThan(350000);
  });

  for (const district of districts) {
    it(`${district.id}: every egg rests on shipped geometry and has a nearby approach`, async () => {
      const scene = await load(district.url);
      scene.updateMatrixWorld(true);
      const meshes: THREE.Mesh[] = [];
      scene.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || /water|foliage|shallow/i.test(mesh.name)) return;
        mesh.geometry.computeBoundsTree = computeBoundsTree as typeof mesh.geometry.computeBoundsTree;
        mesh.geometry.computeBoundsTree();
        if (!(mesh as THREE.InstancedMesh).isInstancedMesh) mesh.raycast = acceleratedRaycast;
        meshes.push(mesh);
      });
      const down = new THREE.Vector3(0, -1, 0);
      function surface(x: number, z: number, top: number, far: number) {
        const hits = new THREE.Raycaster(new THREE.Vector3(x, top, z), down, 0, far).intersectObjects(meshes, false);
        return hits.find(hit => hit.face && hit.face.normal.clone().transformDirection(hit.object.matrixWorld).y > .7);
      }
      for (const egg of manifest.eggs.filter(egg => egg.district === district.id)) {
        const [wx, y, wz] = egg.position;
        const x = wx - district.center[0], z = wz - district.center[1];
        const hit = surface(x, z, y + .025, .05);
        expect(hit, `${egg.id}: no supporting surface`).toBeDefined();
        expect(hit!.point.y, egg.id).toBeCloseTo(y, 3);
        const approach = [[.85, 0], [-.85, 0], [0, .85], [0, -.85]].some(([dx, dz]) => {
          const ground = surface(x + dx, z + dz, y + .025, 1.55);
          if (!ground || y - ground.point.y > 1.25) return false;
          const ray = new THREE.Raycaster(new THREE.Vector3(x + dx, ground.point.y + .1, z + dz), new THREE.Vector3(0, 1, 0), 0, 1.65);
          return ray.intersectObjects(meshes, false).length === 0;
        });
        expect(approach, `${egg.id}: approach obstructed`).toBe(true);
      }
      meshes.forEach(mesh => disposeBoundsTree.call(mesh.geometry));
      // Explicit timeout: this loads a shipped district GLB and BVH-raycasts
      // every egg against it — seconds of real work that fit the default
      // 5000ms on a quiet machine but not on a shared CI box (measured
      // ~6s under load on pristine main, failing as a bare timeout). The
      // assertions are unchanged; the budget now measures the work, not
      // the box.
    }, 30_000);
  }
});
