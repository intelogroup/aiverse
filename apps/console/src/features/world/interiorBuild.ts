// interiorBuild.ts — turns an interior layout into instanced meshes over the shared library.
//
// Geometry and materials belong to the library (loaded once, kept); an interior owns only
// its InstancedMesh objects and their instance buffers. Dropping an interior therefore
// disposes just those buffers — three.js never frees GPU memory by itself, and disposing a
// shared geometry or material here would break every other room that uses it.
import * as THREE from "three";
import { groupByAsset, type InteriorLayout } from "./interiors";

export interface InteriorHandle {
  group: THREE.Group;
  /** InstancedMesh count = draw calls this interior adds. */
  drawCalls: number;
  instances: number;
  /** Frees the instance buffers. Idempotent. */
  dispose: () => void;
}

const LIB_PREFIX = "LIB_";
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _place = new THREE.Matrix4();
const _inst = new THREE.Matrix4();

/** Index the library's top-level assets by key (node name without the LIB_ prefix). */
export function indexLibrary(library: THREE.Object3D): Map<string, THREE.Object3D> {
  const out = new Map<string, THREE.Object3D>();
  library.traverse((o) => {
    if (o.name.startsWith(LIB_PREFIX) && !out.has(o.name.slice(LIB_PREFIX.length))) {
      out.set(o.name.slice(LIB_PREFIX.length), o);
    }
  });
  return out;
}

export function buildInterior(
  layout: InteriorLayout,
  assets: Map<string, THREE.Object3D>,
  /** Shift the whole layout in XZ — used to drop copies of one room elsewhere (debug/tests). */
  offset: [number, number] = [0, 0],
): InteriorHandle {
  const group = new THREE.Group();
  group.name = `interior:${layout.id}`;
  if (layout.id === "tea") {
    for (const prop of layout.props.filter((p) => p[0] === "tea_lantern")) {
      const light = new THREE.PointLight("#ffcf91", 16, 7, 2);
      light.position.set(prop[1] + offset[0], prop[2] + 0.2, prop[3] + offset[1]);
      group.add(light);
    }
  }
  const meshes: THREE.InstancedMesh[] = [];
  let instances = 0;
  for (const [key, props] of groupByAsset(layout.props)) {
    const root = assets.get(key);
    if (!root) continue;
    root.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const parts: { mesh: THREE.Mesh; rel: THREE.Matrix4 }[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) parts.push({ mesh: m, rel: new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld) });
    });
    for (const { mesh, rel } of parts) {
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, props.length);
      props.forEach((p, i) => {
        _pos.set(p[1] + offset[0], p[2], p[3] + offset[1]);
        _quat.setFromAxisAngle(_up, p[4]);
        _scale.setScalar(p[5]);
        _place.compose(_pos, _quat, _scale);
        im.setMatrixAt(i, _inst.multiplyMatrices(_place, rel));
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = true;
      im.receiveShadow = true;
      im.name = `${key}:${mesh.name}`;
      meshes.push(im);
      group.add(im);
      instances += props.length;
    }
  }
  let disposed = false;
  return {
    group,
    drawCalls: meshes.length,
    instances,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const im of meshes) {
        group.remove(im);
        im.dispose(); // instance buffers only: geometry + material stay with the library
      }
      meshes.length = 0;
    },
  };
}
