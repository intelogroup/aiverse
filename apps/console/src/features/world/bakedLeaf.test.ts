// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { MIN_LEAF_TRIANGLES, TEA_LEAF_BOX, findBakedLeaf } from "./bakedLeaf";

const O = { x: -22.9167, z: -72.5 };

/** Indexed geometry from axis-aligned thin boxes (2 tris per face quad is overkill: one triangle per "panel" is enough). */
function geometryFrom(tris: [number, number, number][][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const tri of tris) {
    const base = pos.length / 3;
    for (const v of tri) pos.push(...v);
    idx.push(base, base + 1, base + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(pos.length), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(idx);
  return g;
}

/** A small triangle at door-local (dx, y, dz), `n` of them side by side. */
function leafTris(dx: number, n: number, y = 1.0, dz = -0.2): [number, number, number][][] {
  const out: [number, number, number][][] = [];
  for (let i = 0; i < n; i++) {
    const x = O.x + dx + i * 0.01;
    out.push([[x, y, O.z + dz], [x + 0.005, y, O.z + dz], [x, y + 0.05, O.z + dz]]);
  }
  return out;
}

describe("findBakedLeaf", () => {
  const wall: [number, number, number][][] = [
    ...leafTris(-1.2, 10, 1.0, -0.2), // jamb/wall stuff outside the leaf width
    ...leafTris(0.3, 10, 1.0, -0.6), // behind the leaf (interior side), too deep
    ...leafTris(0.3, 10, 3.2, -0.2), // above the leaf (lintel)
    ...leafTris(0.3, 10, 0.3, -0.2), // below the leaf (threshold)
  ];

  it("selects only triangles fully inside the leaf volume and splits them by side of the door centre", () => {
    const g = geometryFrom([...wall, ...leafTris(-0.6, 15), ...leafTris(0.3, 17)]);
    const b = findBakedLeaf(g, O)!;
    expect(b).not.toBeNull();
    expect(b.count).toBe(32);
    expect(b.left.getAttribute("position").count / 3).toBe(15);
    expect(b.right.getAttribute("position").count / 3).toBe(17);
    expect(b.left.getAttribute("uv")).toBeTruthy();
    // world coordinates kept
    b.left.computeBoundingBox();
    expect(b.left.boundingBox!.max.x).toBeLessThan(O.x);
    b.right.computeBoundingBox();
    expect(b.right.boundingBox!.min.x).toBeGreaterThan(O.x - 0.01);
  });

  it("apply() makes the source triangles zero-area and restore() puts the index back exactly; both are idempotent", () => {
    const g = geometryFrom([...wall, ...leafTris(-0.6, 15), ...leafTris(0.3, 17)]);
    const before = Array.from(g.getIndex()!.array);
    const b = findBakedLeaf(g, O)!;
    b.apply();
    b.apply();
    const after = Array.from(g.getIndex()!.array);
    expect(after).not.toEqual(before);
    let degenerate = 0;
    for (let t = 0; t < after.length / 3; t++) if (after[t * 3] === after[t * 3 + 1] && after[t * 3] === after[t * 3 + 2]) degenerate++;
    expect(degenerate).toBe(32);
    b.restore();
    b.restore();
    expect(Array.from(g.getIndex()!.array)).toEqual(before);
  });

  it("survives the index being reordered between find and apply (three-mesh-bvh does that to the shared mesh): hides the right triangles and restores the same set", () => {
    const g = geometryFrom([...wall, ...leafTris(-0.6, 15), ...leafTris(0.3, 17)]);
    const triples = (): string[] => {
      const a = Array.from(g.getIndex()!.array);
      const out: string[] = [];
      for (let t = 0; t < a.length; t += 3) out.push(`${a[t]},${a[t + 1]},${a[t + 2]}`);
      return out.sort();
    };
    const before = triples();
    const b = findBakedLeaf(g, O)!;
    // reorder: reverse the triangle order (what a BVH partition does, in spirit), vertex ids untouched
    const arr = g.getIndex()!.array as Uint32Array;
    const rev = new Uint32Array(arr.length);
    for (let t = 0; t < arr.length / 3; t++) rev.set(arr.subarray(t * 3, t * 3 + 3), (arr.length / 3 - 1 - t) * 3);
    arr.set(rev);
    b.apply();
    // exactly the 32 leaf triangles are degenerate now, and a rescan finds no live leaf triangle left
    const a2 = Array.from(g.getIndex()!.array);
    let degenerate = 0;
    for (let t = 0; t < a2.length / 3; t++) if (a2[t * 3] === a2[t * 3 + 1] && a2[t * 3] === a2[t * 3 + 2]) degenerate++;
    expect(degenerate).toBe(32);
    expect(findBakedLeaf(g, O)).toBeNull(); // nothing live left to find
    // reorder AGAIN while hidden, then restore: the SET of triangles is exactly the original
    const arr2 = g.getIndex()!.array as Uint32Array;
    const rev2 = new Uint32Array(arr2.length);
    for (let t = 0; t < arr2.length / 3; t++) rev2.set(arr2.subarray(t * 3, t * 3 + 3), (arr2.length / 3 - 1 - t) * 3);
    arr2.set(rev2);
    b.restore();
    expect(triples()).toEqual(before);
  });

  it("refuses a world that is not this door: too few triangles, one-sided, no index, far away", () => {
    expect(findBakedLeaf(geometryFrom([...wall, ...leafTris(-0.6, MIN_LEAF_TRIANGLES - 5), ...leafTris(0.3, 3)]), O)).toBeNull();
    expect(findBakedLeaf(geometryFrom([...wall, ...leafTris(-0.6, 40)]), O)).toBeNull(); // nothing on the right leaf
    const noIndex = geometryFrom(leafTris(-0.6, 30));
    noIndex.setIndex(null);
    expect(findBakedLeaf(noIndex, O)).toBeNull();
    expect(findBakedLeaf(geometryFrom([...leafTris(-0.6, 30), ...leafTris(0.3, 30)]), { x: 100, z: 100 })).toBeNull();
  });

  it("the volume matches the generator's constants (door-local)", () => {
    expect(TEA_LEAF_BOX.halfWidth).toBeGreaterThan(0.72); // HW
    expect(TEA_LEAF_BOX.dzBack).toBeLessThan(-0.24); // TB
    expect(TEA_LEAF_BOX.dzFront).toBeGreaterThan(-0.13); // bead front TR + 0.02
  });
});
