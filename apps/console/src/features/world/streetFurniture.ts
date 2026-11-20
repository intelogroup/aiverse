import * as THREE from "three";

/**
 * The solid part of a street-furniture GLB: every mesh except road paint (`mark_*`, 5 cm decals the walker must cross
 * without stepping up). Returns un-parented clones that share geometry (and so the BVH) with the visible meshes.
 */
export function solidParts(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  const out = new THREE.Group();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m.material as THREE.Material).name.startsWith("mark_")) return;
    const c = new THREE.Mesh(m.geometry, m.material);
    c.applyMatrix4(m.matrixWorld);
    out.add(c);
  });
  out.updateMatrixWorld(true);
  return out;
}
