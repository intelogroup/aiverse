import * as THREE from "three";
import { acceleratedRaycast } from "three-mesh-bvh";

const proxy = new THREE.Mesh();
const localMatrix = new THREE.Matrix4();
const sphere = new THREE.Sphere();
const point = new THREE.Vector3();
const instanceHits: THREE.Intersection[] = [];
type InstanceBounds = { version: number; world: THREE.Matrix4; geometry: THREE.BufferGeometry; matrices: THREE.Matrix4[]; spheres: THREE.Sphere[] };
const cached = new WeakMap<THREE.InstancedMesh, InstanceBounds>();

function instanceBounds(mesh: THREE.InstancedMesh): InstanceBounds {
  let cache = cached.get(mesh);
  if (cache && cache.version === mesh.instanceMatrix.version && cache.geometry === mesh.geometry && cache.matrices.length === mesh.count && cache.world.equals(mesh.matrixWorld)) return cache;
  cache = { version: mesh.instanceMatrix.version, world: mesh.matrixWorld.clone(), geometry: mesh.geometry, matrices: [], spheres: [] };
  const bounds = mesh.geometry.boundingSphere!;
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, localMatrix);
    const matrix = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, localMatrix);
    cache.matrices.push(matrix);
    cache.spheres.push(bounds.clone().applyMatrix4(matrix));
  }
  cached.set(mesh, cache);
  return cache;
}

/** Native InstancedMesh.raycast delegates to an unaccelerated private Mesh. Keep
 * instance transforms/IDs, but use the geometry BVH after a finite-segment broadphase. */
export function cameraInstanceRaycast(this: THREE.InstancedMesh, raycaster: THREE.Raycaster, hits: THREE.Intersection[]): void {
  if (!this.geometry.boundingSphere) this.geometry.computeBoundingSphere();
  const cache = instanceBounds(this);
  proxy.geometry = this.geometry;
  proxy.material = this.material;
  const farSquared = raycaster.far * raycaster.far;
  for (let instanceId = 0; instanceId < this.count; instanceId++) {
    sphere.copy(cache.spheres[instanceId]);
    // Zero-scale instances are used to hide the original tea door.
    if (sphere.radius <= 1e-9) continue;
    if (!sphere.containsPoint(raycaster.ray.origin)) {
      const entry = raycaster.ray.intersectSphere(sphere, point);
      if (!entry || entry.distanceToSquared(raycaster.ray.origin) > farSquared) continue;
    }
    proxy.matrixWorld.copy(cache.matrices[instanceId]);
    instanceHits.length = 0;
    acceleratedRaycast.call(proxy, raycaster, instanceHits);
    for (const hit of instanceHits) {
      hit.instanceId = instanceId;
      hit.object = this;
      hits.push(hit);
    }
  }
  instanceHits.length = 0;
}
