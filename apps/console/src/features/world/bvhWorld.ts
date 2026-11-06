// bvhWorld.ts — the walker's `World` (walker.ts) over three-mesh-bvh meshes (the same ones CameraCollider uses).
//
// Ground: one downward ray from just above the walker's step-up reach (so bridge decks / roofs overhead are
// ignored). Walls: a fan of horizontal rays at two body heights (both above the step-up, so stair risers and
// curbs never read as walls), measured so that the fan approximates a circle of `radius` around the body.
// Water and foliage are not in the mesh set (CameraCollider's SKIP), so open water is "no ground" => blocked.

import * as THREE from "three";
import type { Hit, Vec3, World } from "./walker";

/** Body heights (above the feet) the wall fan is cast at: knee-clear and chest. */
export const WALL_HEIGHTS = [0.55, 1.0];
/** Fan angles (rad) either side of the travel direction. Wide enough to catch walls we graze along. */
const FAN = [0, 0.7, -0.7, 1.31, -1.31];

export function createBvhWorld(getMeshes: () => THREE.Mesh[]): World {
  const rc = Object.assign(new THREE.Raycaster(), { firstHitOnly: true });
  const down = new THREE.Vector3(0, -1, 0);
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const nm = new THREE.Matrix3();

  return {
    groundY(x, z, fromY) {
      const meshes = getMeshes();
      if (!meshes.length) return null;
      rc.set(origin.set(x, fromY, z), down);
      rc.near = 0;
      rc.far = fromY + 40; // down to well below the sea
      const hit = rc.intersectObjects(meshes, false)[0];
      return hit ? fromY - hit.distance : null;
    },

    blocked(from: Vec3, to: Vec3, radius: number): Hit | null {
      const meshes = getMeshes();
      const mx = to[0] - from[0];
      const mz = to[2] - from[2];
      const len = Math.hypot(mx, mz);
      if (!meshes.length) return null;
      // No travel direction (standing): probe all around so we can still be pushed out of an overlap.
      const base = len > 1e-6 ? Math.atan2(mx, mz) : 0;
      const angles = len > 1e-6 ? FAN : [0, Math.PI / 2, Math.PI, -Math.PI / 2];
      let best: Hit | null = null;
      for (const h of WALL_HEIGHTS) {
        for (const a of angles) {
          const ang = base + a;
          const dx = Math.sin(ang);
          const dz = Math.cos(ang);
          // Distance the move covers along this ray; after it the wall must still be `radius` away.
          const along = len > 1e-6 ? len * Math.cos(a) : 0;
          rc.set(origin.set(from[0], from[1] + h, from[2]), dir.set(dx, 0, dz));
          rc.near = 0;
          rc.far = radius + Math.max(0, along) + 0.01;
          const hit = rc.intersectObjects(meshes, false)[0];
          if (!hit) continue;
          const depth = radius + along - hit.distance;
          if (depth <= 0) continue;
          // Horizontal wall normal in world space, facing the walker.
          if (hit.face) {
            nm.getNormalMatrix(hit.object.matrixWorld);
            nrm.copy(hit.face.normal).applyMatrix3(nm);
          } else nrm.set(-dx, 0, -dz);
          let nx = nrm.x;
          let nz = nrm.z;
          let nl = Math.hypot(nx, nz);
          if (nl < 1e-4) { nx = -dx; nz = -dz; nl = 1; } // floor/ceiling-ish face: oppose the ray
          nx /= nl; nz /= nl;
          if (nx * dx + nz * dz > 0) { nx = -nx; nz = -nz; } // face the walker
          if (!best || depth > best.depth) best = { nx, nz, depth };
        }
      }
      return best;
    },
  };
}
