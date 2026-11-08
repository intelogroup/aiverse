import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { resolveDistance, stepDistance } from "./cameraCollision";
import { CameraClearance } from "./cameraClearance";
import { cameraInstanceRaycast } from "./cameraInstanceRaycast";

// BVH extension methods on geometries (only meshes we build a tree for use it). Mesh.prototype.raycast is NOT
// patched globally: collider meshes get acceleratedRaycast per instance, everything else keeps three's raycast.
// Cast: 0.9's computeBoundsTree is typed as returning its GeometryBVH base, its BufferGeometry augmentation as MeshBVH.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree as unknown as THREE.BufferGeometry["computeBoundsTree"];
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

const SKIP = /water|foliage|shallow/i;

/** Solid meshes of `root` that should block the camera, including instanced props. */
function collidable(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (o as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (SKIP.test(m.name)) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (mats.some((x) => SKIP.test(x.name))) return;
    if (!m.geometry.getAttribute("position")) return;
    out.push(m);
  });
  return out;
}

/** Build BVHs for `root`'s collidable meshes (idempotent per geometry); returns the meshes and the build time. */
export function buildColliders(root: THREE.Object3D): { meshes: THREE.Mesh[]; ms: number } {
  const t0 = performance.now();
  const meshes = collidable(root);
  for (const m of meshes) {
    if (!m.geometry.boundsTree) m.geometry.computeBoundsTree();
    m.raycast = (m as THREE.InstancedMesh).isInstancedMesh ? cameraInstanceRaycast : acceleratedRaycast;
  }
  return { meshes, ms: performance.now() - t0 };
}

export type ColliderStats = { colliderHits: number; colliderFrames: number; colliderMs: number };

type Controls = { target: THREE.Vector3; enabled: boolean };

/**
 * Keeps the orbit camera out of City 3's geometry. OrbitControls (drei, useFrame priority -1) re-reads its radius
 * from camera.position every update, so clamping the camera in place would make the clamp permanent. Instead:
 *   priority -2 (before controls.update): put back the user's unclamped position if we moved it last frame and nobody
 *     else moved it since (cam() / hero focus overrides win);
 *   priority 0  (after controls.update, before render): record that position as the desired one, sweep the
 *     near-plane footprint over the collision meshes, snap in on a hit, ease out (rate 6) when clear.
 * OrbitControls damping and zoom therefore keep acting on the desired distance; only the drawn position is clamped.
 * Priorities stay <= 0 so R3F keeps its own render loop.
 */
export function CameraCollider({ getMeshes, enabled, stats }: { getMeshes: () => THREE.Mesh[]; enabled: boolean; stats: ColliderStats }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const desired = useRef(new THREE.Vector3());
  const applied = useRef<THREE.Vector3 | null>(null);
  const shown = useRef<number | null>(null);
  const clearance = useRef(new CameraClearance());
  const dir = useRef(new THREE.Vector3());

  useFrame(() => {
    const a = applied.current;
    if (a && camera.position.distanceToSquared(a) < 1e-10) camera.position.copy(desired.current);
    applied.current = null;
  }, -2);

  useFrame((_, dt) => {
    if (!enabled || !controls) { shown.current = null; return; }
    const meshes = getMeshes();
    const t = controls.target;
    desired.current.copy(camera.position);
    const d = dir.current.subVectors(camera.position, t);
    const len = d.length();
    if (len < 1e-6 || meshes.length === 0) { shown.current = len; return; }
    d.multiplyScalar(1 / len);
    const t0 = performance.now();
    const hit = clearance.current.hitDistance(t, desired.current, camera, meshes);
    stats.colliderMs += performance.now() - t0; stats.colliderFrames++;
    if (hit !== null) stats.colliderHits++;
    const allowed = resolveDistance(len, hit);
    const next = stepDistance(Math.min(shown.current ?? len, len), allowed, dt);
    shown.current = next;
    if (next < len - 1e-4) {
      camera.position.copy(t).addScaledVector(d, next);
      camera.updateMatrixWorld();
      applied.current = camera.position.clone();
    }
  });
  return null;
}
