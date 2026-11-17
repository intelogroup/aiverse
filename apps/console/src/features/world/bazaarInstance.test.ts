import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyBazaarBatch } from "./bazaarBatch";
import { MIN_PLACEMENTS, planBazaarInstance } from "./bazaarInstance";

function fixture() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.position.set(10, 2, -4);
  scene.add(root);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial();
  const originals = Array.from({ length: MIN_PLACEMENTS }, (_, i) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `crate${i}`;
    mesh.position.x = i * 3;
    root.add(mesh);
    return mesh;
  });
  return { scene, root, geometry, material, originals };
}

describe("bazaar instancing composition", () => {
  it("plans without mutation and renders each claimed placement in its original world transform", () => {
    const { scene, root, geometry, originals } = fixture();
    const plan = planBazaarInstance(root);
    expect(plan.claimedObjs.size).toBe(MIN_PLACEMENTS);
    expect(originals.every((o) => o.visible)).toBe(true);
    expect(scene.children).toEqual([root]);
    let sourceDisposed = false;
    geometry.addEventListener("dispose", () => { sourceDisposed = true; });
    const handle = plan.apply(root, scene);
    expect(handle.stats.placements).toBe(MIN_PLACEMENTS);
    expect(originals.every((o) => !o.visible && o.parent === root)).toBe(true);
    const group = scene.children.find((o) => o.name === "__bazaarInstance")!;
    const instances = group.children[0] as THREE.InstancedMesh;
    expect(instances.geometry).toBe(geometry);
    const matrix = new THREE.Matrix4();
    originals.forEach((o, i) => {
      instances.getMatrixAt(i, matrix);
      expect(matrix.elements).toEqual(o.matrixWorld.elements);
    });
    handle.dispose();
    expect(originals.every((o) => o.visible)).toBe(true);
    expect(scene.children).toEqual([root]);
    expect(sourceDisposed).toBe(false);
  });

  it("never claims doors even when they share a repeated geometry", () => {
    const { scene, root, geometry, material } = fixture();
    const doors = Array.from({ length: MIN_PLACEMENTS }, () => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = "TeaDoorLeaf";
      root.add(mesh);
      return mesh;
    });
    const plan = planBazaarInstance(root);
    expect(doors.every((o) => !plan.claimedObjs.has(o))).toBe(true);
    const handle = plan.apply(root, scene);
    expect(doors.every((o) => o.visible)).toBe(true);
    handle.dispose();
  });

  it("excludes claimed originals from batching and restores both passes on cleanup", () => {
    const { scene, root, material, originals } = fixture();
    const singleton = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), material);
    root.add(singleton);
    const plan = planBazaarInstance(root);
    expect(plan.claimedObjs.has(singleton)).toBe(false);
    const batch = applyBazaarBatch(root, scene, "both", { exclude: (it) => plan.claimedObjs.has(it.obj) });
    expect(batch.stats.excludedItems).toBe(MIN_PLACEMENTS);
    expect(batch.stats.pieces).toBe(1);
    expect(originals.every((o) => o.visible)).toBe(true);
    expect(singleton.visible).toBe(false);
    const instance = plan.apply(root, scene);
    expect(instance.stats.placements).toBe(MIN_PLACEMENTS);
    instance.dispose();
    batch.dispose();
    expect(singleton.visible).toBe(true);
    expect(originals.every((o) => o.visible)).toBe(true);
    expect(scene.children).toEqual([root]);
  });
});
