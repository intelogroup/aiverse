import * as THREE from "three";

function clippedHit(hit: THREE.Intersection): boolean {
  const mesh = hit.object as THREE.Mesh;
  const material = Array.isArray(mesh.material) ? mesh.material[hit.face?.materialIndex ?? 0] : mesh.material;
  const planes = material?.clippingPlanes;
  if (!planes?.length) return false;
  return material.clipIntersection ? planes.every(p => p.distanceToPoint(hit.point) < 0) : planes.some(p => p.distanceToPoint(hit.point) < 0);
}

// Animated assemblies are not part of the streamed world's static collider sets.
const dynamicRoots = new Set<THREE.Object3D>();
export function registerCameraObstacle(root: THREE.Object3D): () => void {
  dynamicRoots.add(root);
  return () => { dynamicRoots.delete(root); };
}

// No downward probe: solids sitting on the ground (the tower) have no bottom face, so down always finds the ground.
const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].map(([x, y, z]) => new THREE.Vector3(x, y, z));
const enclosedRay = Object.assign(new THREE.Raycaster(), { firstHitOnly: false });
const normalMatrix = new THREE.Matrix3();
const worldNormal = new THREE.Vector3();

/**
 * True when `point` sits inside closed geometry: the first surface in each horizontal direction and straight up is a
 * back face. An orbit target inside a solid (the plaza's fountain tower) makes every clearance ray hit the solid's inner
 * wall, so the collider would pin the camera against it; the caller skips collision instead. An open spot under an
 * awning or in a room has at least one direction with no hit or a front face first, so it never counts as enclosed.
 */
export function pointEnclosed(point: THREE.Vector3, meshes: THREE.Object3D[], far = 200): boolean {
  if (meshes.length === 0) return false;
  // Back faces of one-sided materials are invisible to raycasts; make them hittable for the probe (as hitDistance does).
  const sides = new Map<THREE.Material, THREE.Side>();
  for (const o of meshes) {
    const m = o as THREE.Mesh;
    for (const material of Array.isArray(m.material) ? m.material : [m.material]) {
      if (material && !sides.has(material)) { sides.set(material, material.side); material.side = THREE.DoubleSide; }
    }
  }
  try {
    for (const dir of AXES) {
      enclosedRay.set(point, dir);
      enclosedRay.near = 0;
      enclosedRay.far = far;
      const hit = enclosedRay.intersectObjects(meshes, false).find((h) => h.object.visible && !clippedHit(h));
      if (!hit?.face) return false;
      normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      worldNormal.copy(hit.face.normal).applyMatrix3(normalMatrix);
      if (worldNormal.dot(dir) <= 0) return false; // front face: the point is outside this surface
    }
    return true;
  } finally {
    for (const [material, side] of sides) material.side = side;
  }
}

/** Reusable nine-ray sweep of the camera's near-plane footprint, including its centre.
 * Parallel probes protect the whole path, not just the camera's centre ray. */
export class CameraClearance {
  private ray = Object.assign(new THREE.Raycaster(), { firstHitOnly: false });
  private direction = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private origin = new THREE.Vector3();
  private hits: THREE.Intersection[] = [];
  private meshes: THREE.Object3D[] = [];
  private sides = new Map<THREE.Material, THREE.Side>();

  hitDistance(target: THREE.Vector3, desired: THREE.Vector3, camera: THREE.Camera, meshes: THREE.Mesh[]): number | null {
    const len = this.direction.subVectors(desired, target).length();
    if (len < 1e-6) return null;
    this.direction.divideScalar(len);
    this.right.crossVectors(this.direction, camera.up).normalize();
    if (this.right.lengthSq() < 1e-8) this.right.set(1, 0, 0);
    this.up.crossVectors(this.right, this.direction).normalize();
    const perspective = camera as THREE.PerspectiveCamera;
    const halfY = perspective.isPerspectiveCamera ? Math.max(0.08, perspective.near * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2)) / perspective.zoom) : 0.15;
    const halfX = perspective.isPerspectiveCamera ? halfY * perspective.aspect : halfY;
    this.meshes.length = 0;
    this.meshes.push(...meshes);
    for (const root of dynamicRoots) {
      root.updateWorldMatrix(true, true);
      root.traverse((o) => { if ((o as THREE.Mesh).isMesh) this.meshes.push(o); });
    }
    // Camera collision must see the underside of one-sided awnings and room walls.
    // Restore shared materials synchronously before rendering.
    for (const o of this.meshes) {
      const m = o as THREE.Mesh;
      for (const material of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!this.sides.has(material)) this.sides.set(material, material.side);
        material.side = THREE.DoubleSide;
      }
    }
    let nearest = Infinity;
    try {
      for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
        this.origin.copy(target).addScaledVector(this.right, halfX * x).addScaledVector(this.up, halfY * y);
        this.ray.set(this.origin, this.direction);
        this.ray.near = 0;
        this.ray.far = len;
        this.hits.length = 0;
        this.ray.intersectObjects(this.meshes, false, this.hits);
        const hit = this.hits.find(h => h.object.visible && !h.object.userData.elevatorDoor && !clippedHit(h));
        if (hit) nearest = Math.min(nearest, hit.distance);
      }
    } finally {
      for (const [material, side] of this.sides) material.side = side;
      this.sides.clear();
    }
    return Number.isFinite(nearest) ? nearest : null;
  }
}
