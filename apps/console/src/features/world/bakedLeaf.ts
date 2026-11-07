// bakedLeaf.ts — finds the colour-dependent door LEAF that tools/city3 bakes into the shared palette mesh.
//
// The hero doors are built in two parts (doors.py, failures-log row 36): everything colour-independent (frame, glass, handle,
// hood, ...) is an instance of one mesh per style, but the LEAF (the painted panels, rails, mullions, raised panels and their
// beads) is baked into the shared "Props" palette mesh, because colour lives in the palette UVs. TeaDoorLeaf animates the
// instanced part; without this module the baked leaf never moved ("the green part of the door doesn't open, the glass does").
//
// findBakedLeaf() selects the leaf's triangles by volume (every vertex inside the leaf's door-local box), copies them into two
// standalone geometries (left / right of the door centre, still in WORLD coordinates) and offers an idempotent apply() that
// degenerates them in the source index buffer plus a restore(). The source geometry is the GLB's shared one: only its index
// triples are edited, in place, and always put back.
import * as THREE from "three";

/** The leaf's volume relative to the door origin (x, z) and in world y; margins of ~1 cm around the generator's constants
 * (HW 0.72, Z0 0.31 / Z1 2.40 above street level 0.20, back face t = -0.24, bead front t = -0.13). */
export interface LeafBox {
  halfWidth: number;
  y0: number;
  y1: number;
  /** z offsets from the door origin: back face .. front-most bead. */
  dzBack: number;
  dzFront: number;
}

export const TEA_LEAF_BOX: LeafBox = { halfWidth: 0.735, y0: 0.5, y1: 2.62, dzBack: -0.245, dzFront: -0.125 };

/** Fewer triangles than this is not a leaf (a different build of the world): leave the door alone. */
export const MIN_LEAF_TRIANGLES = 20;

export interface BakedLeaf {
  /** Triangles found. */
  count: number;
  /** World-space copies, split by the sign of the centroid x relative to the door centre (left = active hinge side). */
  left: THREE.BufferGeometry;
  right: THREE.BufferGeometry;
  /** Make the source triangles invisible (zero area). Idempotent. */
  apply(): void;
  /** Put the source index back. Idempotent. */
  restore(): void;
}

function copyTriangles(src: THREE.BufferGeometry, tris: number[]): THREE.BufferGeometry {
  const idx = src.getIndex()!;
  const g = new THREE.BufferGeometry();
  for (const [name, size] of [["position", 3], ["normal", 3], ["uv", 2]] as const) {
    const a = src.getAttribute(name);
    if (!a) continue;
    const out = new Float32Array(tris.length * 3 * size);
    tris.forEach((t, k) => {
      for (let c = 0; c < 3; c++) {
        const vi = idx.getX(t * 3 + c);
        for (let s = 0; s < size; s++) out[(k * 3 + c) * size + s] = s === 0 ? a.getX(vi) : s === 1 ? a.getY(vi) : a.getZ(vi);
      }
    });
    g.setAttribute(name, new THREE.BufferAttribute(out, size));
  }
  return g;
}

export function findBakedLeaf(
  src: THREE.BufferGeometry,
  origin: { x: number; z: number },
  box: LeafBox = TEA_LEAF_BOX,
): BakedLeaf | null {
  const idx = src.getIndex();
  const pos = src.getAttribute("position");
  if (!idx || !pos) return null;
  src.computeBoundingBox();
  const bb = src.boundingBox!;
  const x0 = origin.x - box.halfWidth;
  const x1 = origin.x + box.halfWidth;
  const z0 = origin.z + box.dzBack;
  const z1 = origin.z + box.dzFront;
  if (bb.max.x < x0 || bb.min.x > x1 || bb.max.z < z0 || bb.min.z > z1) return null;

  /** Slots (triangle numbers in the CURRENT index order) of live triangles fully inside the leaf volume, split by side.
   * Slot numbers are only valid until the index is next reordered: three-mesh-bvh reorders it in place when the camera
   * collider builds its BVH on this mesh, at some unrelated moment. So nothing below remembers slots across calls. */
  const scan = () => {
    const left: number[] = [];
    const right: number[] = [];
    const triCount = idx.count / 3;
    for (let t = 0; t < triCount; t++) {
      const a = idx.getX(t * 3);
      if (a === idx.getX(t * 3 + 1) && a === idx.getX(t * 3 + 2)) continue; // already degenerate
      let inside = true;
      let cx = 0;
      for (let c = 0; c < 3 && inside; c++) {
        const vi = idx.getX(t * 3 + c);
        const x = pos.getX(vi);
        const y = pos.getY(vi);
        const z = pos.getZ(vi);
        if (x < x0 || x > x1 || y < box.y0 || y > box.y1 || z < z0 || z > z1) inside = false;
        cx += x;
      }
      if (inside) (cx / 3 - origin.x < 0 ? left : right).push(t);
    }
    return { left, right };
  };

  const found = scan();
  if (found.left.length + found.right.length < MIN_LEAF_TRIANGLES || !found.left.length || !found.right.length) return null;
  const leftGeo = copyTriangles(src, found.left);
  const rightGeo = copyTriangles(src, found.right);

  // What apply() degenerated: first vertex id -> the (b, c) pairs it overwrote (a quad's two triangles can share vertex a).
  let hidden: Map<number, [number, number][]> | null = null;
  return {
    count: found.left.length + found.right.length,
    left: leftGeo,
    right: rightGeo,
    apply() {
      if (hidden) return;
      hidden = new Map();
      const { left, right } = scan(); // positions, not remembered slots: the index may have been reordered since find
      for (const t of [...left, ...right].sort((p, q) => p - q)) { // ascending: restore() refills in the same order
        const a = idx.getX(t * 3);
        const list = hidden.get(a) ?? [];
        list.push([idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)]);
        hidden.set(a, list);
        idx.setX(t * 3 + 1, a);
        idx.setX(t * 3 + 2, a);
      }
      idx.needsUpdate = true;
    },
    restore() {
      if (!hidden) return;
      const saved = hidden;
      hidden = null;
      const triCount = idx.count / 3;
      for (let t = 0; t < triCount && saved.size; t++) {
        const a = idx.getX(t * 3);
        if (a !== idx.getX(t * 3 + 1) || a !== idx.getX(t * 3 + 2)) continue;
        const list = saved.get(a);
        if (!list) continue;
        const [b, c] = list.shift()!; // FIFO: apply() recorded them in ascending slot order, so an unreordered index restores exactly
        idx.setX(t * 3 + 1, b);
        idx.setX(t * 3 + 2, c);
        if (!list.length) saved.delete(a);
      }
      idx.needsUpdate = true;
    },
  };
}
