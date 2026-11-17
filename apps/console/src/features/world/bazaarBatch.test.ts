import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyBazaarBatch } from "./bazaarBatch";

function fixture() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.position.set(10, 2, -4);
  scene.add(root);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial();
  const mesh = (name: string, x: number) => {
    const m = new THREE.Mesh(geometry, material);
    m.name = name;
    m.position.x = x;
    root.add(m);
    return m;
  };
  return { scene, root, geometry, mesh };
}

describe("bazaar batching lifecycle", () => {
  it("census leaves the original scene visible and unchanged", () => {
    const { scene, root, mesh } = fixture();
    const prop = mesh("crate", 0);
    const handle = applyBazaarBatch(root, scene, "census");
    expect(handle.census().inScope.items).toBe(1);
    expect(prop.visible).toBe(true);
    expect(scene.children).toEqual([root]);
    handle.dispose();
  });

  it("bakes world transforms, retains collider geometry, and restores visibility on disposal", () => {
    const { scene, root, geometry, mesh } = fixture();
    const a = mesh("crateA", 0);
    const b = mesh("crateB", 2);
    const originalPositions = Array.from(geometry.attributes.position.array);
    let sourceDisposed = false;
    geometry.addEventListener("dispose", () => { sourceDisposed = true; });
    const handle = applyBazaarBatch(root, scene, "both");
    expect(a.visible).toBe(false);
    expect(b.visible).toBe(false);
    expect(a.parent).toBe(root);
    expect(a.geometry).toBe(geometry);
    expect(Array.from(geometry.attributes.position.array)).toEqual(originalPositions);
    const group = scene.children.find((o) => o.name === "__bazaarBatch")!;
    const batch = group.children[0] as THREE.Mesh;
    batch.geometry.computeBoundingBox();
    expect(batch.geometry.boundingBox!.min.toArray()).toEqual([9.5, 1.5, -4.5]);
    expect(batch.geometry.boundingBox!.max.toArray()).toEqual([12.5, 2.5, -3.5]);
    handle.dispose();
    expect(a.visible).toBe(true);
    expect(b.visible).toBe(true);
    expect(scene.children).toEqual([root]);
    expect(sourceDisposed).toBe(false);
  });

  it("keeps doors, stateful objects, and hidden meshes out of the bake", () => {
    const { scene, root, mesh } = fixture();
    const door = mesh("TeaDoorLeaf", 0);
    const radio = mesh("radio", 1);
    const hidden = mesh("hiddenCrate", 2);
    hidden.visible = false;
    const prop = mesh("crate", 3);
    const handle = applyBazaarBatch(root, scene, "both");
    expect(handle.census().inScope.items).toBe(1);
    expect(door.visible).toBe(true);
    expect(radio.visible).toBe(true);
    expect(prop.visible).toBe(false);
    handle.dispose();
    expect(hidden.visible).toBe(false);
  });

  it("cell splitting retains instance transforms and colors without disposing the source geometry", () => {
    const { scene, root, geometry } = fixture();
    const im = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 2);
    im.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 0));
    im.setMatrixAt(1, new THREE.Matrix4().makeTranslation(256, 0, 0));
    im.setColorAt(0, new THREE.Color("red"));
    im.setColorAt(1, new THREE.Color("blue"));
    root.add(im);
    const handle = applyBazaarBatch(root, scene, "cells");
    const copies = root.children.filter((o) => o !== im) as THREE.InstancedMesh[];
    expect(copies).toHaveLength(2);
    const positions = copies.map((m) => {
      const matrix = new THREE.Matrix4();
      m.getMatrixAt(0, matrix);
      return matrix.elements[12];
    });
    expect(positions).toEqual([0, 256]);
    expect(copies.map((m) => m.geometry)).toEqual([geometry, geometry]);
    expect(copies.map((m) => Array.from(m.instanceColor!.array))).toEqual([[1, 0, 0], [0, 0, 1]]);
    handle.dispose();
    expect(root.children).toEqual([im]);
    expect(im.visible).toBe(true);
  });
});
