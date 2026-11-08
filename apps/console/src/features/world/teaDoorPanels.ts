import * as THREE from "three";
import { TEA_DOOR_ORIGIN, TEA_GROUND_Y } from "./teaDoor";

// Painted leaves are baked into the world palette, separately from DI_2 glass.
// Match whole triangles in the authored leaf slab, never the surrounding jamb.
export function splitTeaPanels(src: THREE.BufferGeometry, matrix: THREE.Matrix4) {
  const pos = src.getAttribute("position"), index = src.getIndex();
  const count = index?.count ?? pos.count;
  const keep: number[] = [], left: number[] = [], right: number[] = [];
  const v = new THREE.Vector3();
  const local = new THREE.Matrix4().makeTranslation(-TEA_DOOR_ORIGIN.x, -TEA_GROUND_Y, -TEA_DOOR_ORIGIN.z).multiply(matrix);
  for (let t = 0; t < count; t += 3) {
    const ids = [0, 1, 2].map(k => index ? index.getX(t + k) : t + k);
    let inside = true, cx = 0;
    for (const id of ids) {
      v.fromBufferAttribute(pos, id).applyMatrix4(local);
      cx += v.x;
      inside &&= Math.abs(v.x) <= 0.721 && v.y >= 0.309 && v.y <= 2.401 && v.z >= -0.241 && v.z <= -0.124;
    }
    // The central overlapping stile belongs to the active (left) leaf.
    (inside ? (cx / 3 <= 0.021 ? left : right) : keep).push(...ids);
  }
  if (!left.length || !right.length) return null;
  const remaining = src.clone();
  remaining.setIndex(keep);
  const part = (ids: number[]) => {
    const g = src.clone();
    g.setIndex(ids);
    const out = g.toNonIndexed();
    g.dispose();
    out.applyMatrix4(local);
    out.computeBoundingBox(); out.computeBoundingSphere();
    return out;
  };
  return { remaining, left: part(left), right: part(right), triangles: (left.length + right.length) / 3 };
}
