// capsuleWorld.ts — the walker's `World` (walker.ts) over a dedicated COLLISION mesh list (three-mesh-bvh).
//
// Not the visual meshes: the collision GLBs (tools/city3, objects `col_*`) hold closed solids, ground quads and
// hero-room shells. Meshes handed in here are in WORLD space already (use `bakeCollisionRoot`, which bakes
// matrixWorld into the geometry and merges everything of one file into ONE mesh with ONE BVH).
//
// Walls: the official three-mesh-bvh characterMovement pattern. A vertical capsule (segment + radius) is tested
// against the triangles with `shapecast`; each overlap pushes the capsule out along (capsule point - triangle point).
// shapecast ignores material.side, so a wall is solid from BOTH sides by construction (the old raycast world let
// you walk through the back of a one-sided quad). The push is applied HORIZONTALLY only (the walker owns y through
// groundY/step-up): for a contact with horizontal separation sh and vertical offset sv, the exact horizontal move that
// restores distance r is sqrt(r^2 - sv^2) - sh.
//
// The capsule starts at feet + stepUp, so risers/curbs up to the step-up never read as walls; whether a higher
// ledge is a wall falls out of the same geometry (its edge enters the lower sphere) plus walker.walkableY.
//
// Tunnelling: the move from -> to is swept in substeps of <= radius/2 and each substep is resolved before the next,
// so running (2.7 m/s) or a big dt cannot step over a thin wall (a zero-thickness quad is even enough).
//
// Ground: highest UP-facing surface at or below `fromY` (undersides of decks/ceilings are ignored, so the floor of
// a room is found from inside it and a closed solid's underside never counts).

import * as THREE from "three";
import { MeshBVH, type ExtendedTriangle } from "three-mesh-bvh";
import type { Hit, Vec3, World } from "./walker";
import { WALK_CONFIG } from "./walker";

/** Standing body height (feet to top of head), m. */
export const BODY_HEIGHT = 1.7;

export interface CapsuleOptions {
  /** Capsule bottom sphere starts this far above the feet (default WALK_CONFIG.stepUp). */
  stepUp?: number;
  height?: number;
  /** Max substep length as a fraction of the radius. */
  substep?: number;
}

export interface CapsuleCounters {
  blockedCalls: number;
  groundCalls: number;
  triTests: number;
}

/** userData flag: a collider mesh that never provides ground (invisible furniture boxes: walls only). */
export const NO_GROUND = "noGround";

const EPS = 1e-6;

export function createCapsuleWorld(getMeshes: () => THREE.Mesh[], opts: CapsuleOptions = {}): World & { counters: CapsuleCounters } {
  const stepUp = opts.stepUp ?? WALK_CONFIG.stepUp;
  const height = opts.height ?? BODY_HEIGHT;
  const subFrac = opts.substep ?? 0.5;
  const counters: CapsuleCounters = { blockedCalls: 0, groundCalls: 0, triTests: 0 };

  const seg = new THREE.Line3();
  const box = new THREE.Box3();
  const triPoint = new THREE.Vector3();
  const capPoint = new THREE.Vector3();
  const dirV = new THREE.Vector3();
  const tmpMid = new THREE.Vector3();
  const ray = new THREE.Ray();
  const down = new THREE.Vector3(0, -1, 0);
  const tn = new THREE.Vector3();
  const push: [number, number] = [0, 0];

  const bvhOf = (m: THREE.Mesh): MeshBVH | null => (m.geometry.boundsTree as MeshBVH | undefined) ?? null;

  /**
   * Resolve the capsule standing with its feet at (x, y, z) against every collider; writes the horizontal push
   * (px, pz) that gets it out (iterated so two walls at a corner both get satisfied).
   */
  function resolveAt(meshes: THREE.Mesh[], x: number, y: number, z: number, r: number, out: [number, number]): void {
    let px = 0;
    let pz = 0;
    // Sphere centres are placed for the walking radius even when a larger clearance radius is probed (spawn search).
    const r0 = Math.min(r, WALK_CONFIG.radius);
    const y0 = y + stepUp + r0;
    const y1 = Math.max(y0, y + height - r0);
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      for (const m of meshes) {
        if (m.userData.collisionDisabled) continue;
        const bvh = bvhOf(m);
        if (!bvh) continue;
        const offset = m.userData.collisionOffset as THREE.Vector3 | undefined;
        seg.start.set(x + px - (offset?.x ?? 0), y0 - (offset?.y ?? 0), z + pz - (offset?.z ?? 0));
        seg.end.set(x + px - (offset?.x ?? 0), y1 - (offset?.y ?? 0), z + pz - (offset?.z ?? 0));
        box.makeEmpty();
        box.expandByPoint(seg.start);
        box.expandByPoint(seg.end);
        box.min.addScalar(-r);
        box.max.addScalar(r);
        let ax = 0;
        let az = 0;
        bvh.shapecast({
          intersectsBounds: (b) => b.intersectsBox(box),
          intersectsTriangle: (tri: ExtendedTriangle) => {
            counters.triTests++;
            // seg is read live: earlier triangles of this pass already nudged it.
            const d = tri.closestPointToSegment(seg, triPoint, capPoint);
            if (d >= r) return false;
            if (d > EPS) dirV.subVectors(capPoint, triPoint).divideScalar(d);
            else {
              // Segment crosses the triangle: push along the face normal, toward the capsule axis.
              tri.getNormal(tn);
              dirV.copy(tn);
              if (dirV.dot(tmpMid.addVectors(seg.start, seg.end).multiplyScalar(0.5).sub(triPoint)) < 0) dirV.negate();
            }
            const h = Math.hypot(dirV.x, dirV.z);
            if (h < 0.05) return false; // floor/ceiling-like contact: the walker's ground logic owns vertical
            const sv = d * dirV.y;
            const sh = d * h;
            const need = Math.sqrt(Math.max(0, r * r - sv * sv)) - sh;
            if (need <= 1e-5) return false;
            const ux = dirV.x / h;
            const uz = dirV.z / h;
            seg.start.x += ux * need; seg.end.x += ux * need;
            seg.start.z += uz * need; seg.end.z += uz * need;
            ax += ux * need;
            az += uz * need;
            return false;
          },
        });
        if (ax !== 0 || az !== 0) {
          px += ax; pz += az;
          moved = true;
        }
      }
      if (!moved) break;
    }
    out[0] = px;
    out[1] = pz;
  }

  return {
    counters,

    groundY(x, z, fromY) {
      counters.groundCalls++;
      let best: number | null = null;
      ray.origin.set(x, fromY, z);
      ray.direction.copy(down);
      for (const m of getMeshes()) {
        if (m.userData[NO_GROUND] || m.userData.collisionDisabled) continue;
        const bvh = bvhOf(m);
        if (!bvh) continue;
        const offset = m.userData.collisionOffset as THREE.Vector3 | undefined;
        ray.origin.set(x - (offset?.x ?? 0), fromY - (offset?.y ?? 0), z - (offset?.z ?? 0));
        const hits = bvh.raycast(ray, THREE.DoubleSide, 0, fromY + 40);
        for (const h of hits) {
          if (!h.face || h.face.normal.y < 0.2) continue; // undersides, walls
          const y = h.point.y + (offset?.y ?? 0);
          if (best === null || y > best) best = y;
        }
      }
      return best;
    },

    blocked(from: Vec3, to: Vec3, radius: number): Hit | null {
      counters.blockedCalls++;
      const meshes = getMeshes();
      if (!meshes.length) return null;
      const mx = to[0] - from[0];
      const mz = to[2] - from[2];
      const n = Math.max(1, Math.ceil(Math.hypot(mx, mz) / (radius * subFrac)));
      // Sweep: resolve each substep position, carrying the accumulated push so the path bends around walls;
      // the total push at `to` is what the walker is told to remove.
      let cx = 0;
      let cz = 0;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        resolveAt(meshes, from[0] + mx * t + cx, from[1], from[2] + mz * t + cz, radius, push);
        cx += push[0];
        cz += push[1];
      }
      const depth = Math.hypot(cx, cz);
      if (depth < 1e-4) return null;
      return { nx: cx / depth, nz: cz / depth, depth };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Building collider meshes

const _v = new THREE.Vector3();

/**
 * Collision meshes of a loaded GLB: every mesh whose name (or any ancestor's) starts with `col_` — or every mesh
 * when none is so named — baked into world space and merged into ONE position-only indexed mesh with a BVH.
 * The source scene is left untouched (callers dispose it); the returned mesh owns its geometry.
 */
export function bakeCollisionRoot(root: THREE.Object3D, name = "collision", accept: (m: THREE.Mesh) => boolean = () => true): THREE.Mesh | null {
  root.updateWorldMatrix(true, true);
  const picked: THREE.Mesh[] = [];
  const any: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || !m.geometry.getAttribute("position") || !accept(m)) return;
    any.push(m);
    let p: THREE.Object3D | null = m;
    while (p) {
      if (p.name.startsWith("col_")) { picked.push(m); return; }
      p = p.parent;
    }
  });
  const src = picked.length ? picked : any;
  if (!src.length) return null;
  let verts = 0;
  let idxs = 0;
  for (const m of src) {
    verts += m.geometry.getAttribute("position").count;
    idxs += m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute("position").count;
  }
  const pos = new Float32Array(verts * 3);
  const index = new Uint32Array(idxs);
  let vo = 0;
  let io = 0;
  for (const m of src) {
    const g = m.geometry;
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      pos[(vo + i) * 3] = _v.x; pos[(vo + i) * 3 + 1] = _v.y; pos[(vo + i) * 3 + 2] = _v.z;
    }
    // A mirrored transform flips winding; ground wants true normals.
    const flip = m.matrixWorld.determinant() < 0;
    const cnt = g.index ? g.index.count : p.count;
    for (let i = 0; i < cnt; i += 3) {
      const a = g.index ? g.index.getX(i) : i;
      const b = g.index ? g.index.getX(i + 1) : i + 1;
      const c = g.index ? g.index.getX(i + 2) : i + 2;
      index[io + i] = vo + a;
      index[io + i + 1] = vo + (flip ? c : b);
      index[io + i + 2] = vo + (flip ? b : c);
    }
    vo += p.count;
    io += cnt;
  }
  return meshFromArrays(pos, index, name);
}

/** Keep structural blockers out of ground queries: door leaves, rails and glazing cannot become floors. */
export function bakeCollisionParts(root: THREE.Object3D, name = "collision", accept: (m: THREE.Mesh) => boolean = () => true): THREE.Mesh[] {
  const floor = bakeCollisionRoot(root, name, (m) => accept(m) && m.userData.noGround !== true);
  const blockers = bakeCollisionRoot(root, `${name}:blockers`, (m) => accept(m) && m.userData.noGround === true);
  if (blockers) blockers.userData[NO_GROUND] = true;
  return [floor, blockers].filter((m): m is THREE.Mesh => m !== null);
}

/** A collider mesh from raw arrays: builds the BVH. Not added to any scene. */
export function meshFromArrays(pos: Float32Array, index: Uint32Array, name: string): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.boundsTree = new MeshBVH(g) as unknown as typeof g.boundsTree;
  const m = new THREE.Mesh(g);
  m.name = name;
  m.visible = false;
  return m;
}

/** Free a collider mesh's BVH and geometry. */
export function disposeCollider(m: THREE.Mesh): void {
  m.geometry.boundsTree = undefined;
  m.geometry.dispose();
}

/** One furniture box: [cx, cz, hx, hz, y0, y1, rotY] (rotY as three's rotation.y). */
export type ColBox = [cx: number, cz: number, hx: number, hz: number, y0: number, y1: number, rotY: number];

const BOX_FACES = [
  [0, 1, 3, 0, 3, 2], // y- (bottom)
  [4, 6, 7, 4, 7, 5], // y+ (top)
  [0, 4, 5, 0, 5, 1], // z-
  [2, 3, 7, 2, 7, 6], // z+
  [0, 2, 6, 0, 6, 4], // x-
  [1, 5, 7, 1, 7, 3], // x+
].flat();

/** Closed boxes (12 triangles each) -> ONE merged collider mesh with a BVH. Walls only (`noGround`). */
export function boxesMesh(boxes: readonly ColBox[], offset: [number, number] = [0, 0], name = "interior-boxes"): THREE.Mesh | null {
  if (!boxes.length) return null;
  const pos = new Float32Array(boxes.length * 8 * 3);
  const index = new Uint32Array(boxes.length * 36);
  boxes.forEach(([cx, cz, hx, hz, y0, y1, rot], b) => {
    const s = Math.sin(rot);
    const c = Math.cos(rot);
    for (let k = 0; k < 8; k++) {
      const lx = k & 1 ? hx : -hx;
      const lz = k & 2 ? hz : -hz;
      // three rotation.y = rot: x' = x cos + z sin, z' = -x sin + z cos
      pos[(b * 8 + k) * 3] = cx + offset[0] + lx * c + lz * s;
      pos[(b * 8 + k) * 3 + 1] = k & 4 ? y1 : y0;
      pos[(b * 8 + k) * 3 + 2] = cz + offset[1] - lx * s + lz * c;
    }
    for (let i = 0; i < 36; i++) index[b * 36 + i] = b * 8 + BOX_FACES[i];
  });
  const m = meshFromArrays(pos, index, name);
  m.userData[NO_GROUND] = true;
  return m;
}
