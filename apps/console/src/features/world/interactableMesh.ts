// interactableMesh.ts — the visible side of an interactable (see interactables.ts).
//
// A usable prop is NOT part of the instanced room layout (instances have no identity). It is cloned from the shared
// asset library as a few plain Meshes that SHARE the library's geometry and materials, plus one small pilot light
// that is OURS (its own geometry and materials): on = warm glow, off = a dead dark bead. Disposing frees only what we
// made; the library's geometry/material stay with the library (same rule as interiorBuild.ts).
import * as THREE from "three";
import type { InteractableDef } from "./interactables";

export interface InteractableVisual {
  group: THREE.Group;
  /** Flip the pilot light. */
  setOn: (on: boolean) => void;
  /** Frees the pilot light's own geometry + materials. Idempotent. */
  dispose: () => void;
}

export const PILOT_ON = 0xff8a22;
export const PILOT_OFF = 0x2a1410;

/** Clone `def.asset` from the library `assets` (LIB_ index, see interiorBuild.indexLibrary); null if the asset is missing. */
export function buildInteractableVisual(
  def: InteractableDef,
  assets: Map<string, THREE.Object3D>,
  /** Shift in XZ, as for buildInterior (debug copies of a room). */
  offset: [number, number] = [0, 0],
): InteractableVisual | null {
  const root = assets.get(def.asset);
  if (!root) return null;
  const group = new THREE.Group();
  group.name = `interactable:${def.id}`;
  group.position.set(def.pos[0] + offset[0], def.pos[1], def.pos[2] + offset[1]);
  group.rotation.y = def.rotY;

  root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((o) => {
    const src = o as THREE.Mesh;
    if (!src.isMesh) return;
    const m = new THREE.Mesh(src.geometry, src.material);
    m.matrixAutoUpdate = false;
    m.matrix.multiplyMatrices(inv, src.matrixWorld);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = `${def.asset}:${src.name}`;
    group.add(m);
  });

  // Pilot light: a bead on the top face, sized from the asset's own bounds so it reads on any prop.
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const r = Math.max(0.008, Math.min(0.02, size.y * 0.07));
  const beadGeo = new THREE.SphereGeometry(r, 12, 8);
  const beadMat = new THREE.MeshBasicMaterial({ color: PILOT_OFF });
  const haloGeo = new THREE.SphereGeometry(r * 2.4, 12, 8);
  const haloMat = new THREE.MeshBasicMaterial({ color: PILOT_ON, transparent: true, opacity: 0.28, depthWrite: false });
  const bead = new THREE.Mesh(beadGeo, beadMat);
  const halo = new THREE.Mesh(haloGeo, haloMat);
  // Group-local top centre, nudged toward the front-left corner so it is not hidden by a handle or dial.
  const topLocal = group.worldToLocal(new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2));
  bead.position.copy(topLocal).add(new THREE.Vector3(-size.x * 0.28, r * 0.6, size.z * 0.18));
  halo.position.copy(bead.position);
  bead.name = `${def.id}:pilot`;
  halo.name = `${def.id}:pilot-halo`;
  halo.visible = false;
  group.add(bead, halo);

  let disposed = false;
  return {
    group,
    setOn(on: boolean) {
      beadMat.color.setHex(on ? PILOT_ON : PILOT_OFF);
      halo.visible = on;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.remove(bead, halo);
      beadGeo.dispose();
      haloGeo.dispose();
      beadMat.dispose();
      haloMat.dispose();
    },
  };
}
