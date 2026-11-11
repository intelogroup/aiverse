// look.ts — what a body sees in one glance: a small depth image and a class image from rays cast at the collision geometry.
//
// Pure given a World with `raycast`. No colour, no textures, no names: depth (mm) and one class per pixel. Other bodies appear only as
// the "body" class (no handle); the P3 scene carries handles, so an agent matches the two by bearing. Collision geometry, not the
// visual one: glass reads opaque, doors read as wall, and a seat or prop is a small marker sphere, not its mesh.
import type { Vec3, World } from "./walker";

export const LOOK_W = 128;
export const LOOK_H = 72;
export const LOOK_HFOV_DEG = 86;
export const LOOK_FAR_M = 40;
/** Depth sample for "nothing within range" (sky, void, past LOOK_FAR_M). */
export const LOOK_NO_HIT = 65535;

/** Class codes in the class image (the legend sent with every look). Codes never move: new classes are appended. */
export const LOOK_CLASSES = { sky: 0, floor: 1, wall: 2, seat: 3, prop: 4, body: 5, door: 6 } as const;
/** A door reads as `door` when its rectangle is within this of the wall behind it (a closed leaf and the wall are coplanar). */
const DOOR_SLACK_M = 0.08;
export const LOOK_LEGEND: Record<number, string> = Object.fromEntries(Object.entries(LOOK_CLASSES).map(([k, v]) => [v, k]));

export interface LookSphere { c: Vec3; r: number; cls: number }
/** A body: a vertical cylinder from y0 to y1 around (x, z). */
export interface LookCylinder { x: number; z: number; y0: number; y1: number; r: number }
/** A doorway: a rectangle in a wall plane. axis "x": the wall is the plane x = at and the door spans z in mid +- half; axis "z" is the other way round. */
export interface LookDoor { axis: "x" | "z"; at: number; mid: number; half: number; y0: number; y1: number }
export interface LookScene { spheres: LookSphere[]; bodies: LookCylinder[]; doors: LookDoor[] }

export interface LookResult {
  width: number;
  height: number;
  /** Millimetres along the ray, row-major from the top-left; LOOK_NO_HIT where nothing was hit. */
  depthMm: Uint16Array;
  classes: Uint8Array;
}

/** Nearest positive ray-sphere distance, or Infinity. */
function raySphere(o: Vec3, d: Vec3, s: LookSphere): number {
  const lx = s.c[0] - o[0], ly = s.c[1] - o[1], lz = s.c[2] - o[2];
  const tca = lx * d[0] + ly * d[1] + lz * d[2];
  if (tca < 0) return Infinity;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca, r2 = s.r * s.r;
  if (d2 > r2) return Infinity;
  return tca - Math.sqrt(r2 - d2);
}

/** Nearest ray-cylinder (side wall only) distance within its height, or Infinity. */
function rayCylinder(o: Vec3, d: Vec3, c: LookCylinder): number {
  const ox = o[0] - c.x, oz = o[2] - c.z, a = d[0] * d[0] + d[2] * d[2];
  if (a < 1e-9) return Infinity;
  const b = 2 * (ox * d[0] + oz * d[2]), k = ox * ox + oz * oz - c.r * c.r, disc = b * b - 4 * a * k;
  if (disc < 0) return Infinity;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0) return Infinity;
  const y = o[1] + d[1] * t;
  return y >= c.y0 && y <= c.y1 ? t : Infinity;
}

/** Distance to the door rectangle, or Infinity. */
function rayDoor(o: Vec3, d: Vec3, r: LookDoor): number {
  const [along, across, up] = r.axis === "x" ? [0, 2, 1] : [2, 0, 1];
  if (Math.abs(d[along]) < 1e-6) return Infinity;
  const t = (r.at - o[along]) / d[along];
  if (t <= 0) return Infinity;
  const c = o[across] + d[across] * t, y = o[up] + d[up] * t;
  return Math.abs(c - r.mid) <= r.half && y >= r.y0 && y <= r.y1 ? t : Infinity;
}

export interface LookOpts {
  /** Cast every one of the 9,216 rays (the reference the adaptive pass is measured against). Default: adaptive. */
  full?: boolean;
}

/**
 * Cast a LOOK_W x LOOK_H grid of rays from `eye`, the camera facing `heading` (walker convention: forward is (sin h, cos h)).
 * Columns run left to right with increasing bearing, the same sign `observe` uses.
 *
 * The collision raycast is the whole cost (about 6 us per ray). So it is adaptive: first one ray per 2x2 block (a quarter of them),
 * then the other three only where the block's four corner samples disagree (a miss next to a hit, floor next to wall, a depth jump
 * or a surface that is not a plane). A smooth wall or floor is filled by interpolating its corners. Doors, seats, props and bodies are
 * still tested per pixel afterwards, so a small marker is never skipped.
 */
export function renderLook(world: World, eye: Vec3, heading: number, scene: LookScene, farM = LOOK_FAR_M, opts: LookOpts = {}): LookResult {
  const depthMm = new Uint16Array(LOOK_W * LOOK_H).fill(LOOK_NO_HIT), classes = new Uint8Array(LOOK_W * LOOK_H);
  const tanH = Math.tan((LOOK_HFOV_DEG * Math.PI) / 360), tanV = tanH * (LOOK_H / LOOK_W);
  const fx = Math.sin(heading), fz = Math.cos(heading), rx = Math.cos(heading), rz = -Math.sin(heading);
  const n = LOOK_W * LOOK_H, dirs = new Float32Array(n * 3), dist = new Float32Array(n), ny = new Float32Array(n);
  for (let j = 0; j < LOOK_H; j++) {
    const v = (1 - ((j + 0.5) / LOOK_H) * 2) * tanV;
    for (let i = 0; i < LOOK_W; i++) {
      const u = (((i + 0.5) / LOOK_W) * 2 - 1) * tanH, k = j * LOOK_W + i;
      const x = fx + rx * u, y = v, z = fz + rz * u, m = Math.hypot(x, y, z);
      dirs[3 * k] = x / m; dirs[3 * k + 1] = y / m; dirs[3 * k + 2] = z / m;
    }
  }
  /** Cast the rays with these pixel numbers in one batch (the world culls its colliders once per batch). */
  const cast = (ids: number[]) => {
    if (!ids.length) return;
    const sub = new Float32Array(ids.length * 3), sd = new Float32Array(ids.length), sn = new Float32Array(ids.length);
    ids.forEach((k, q) => { sub[3 * q] = dirs[3 * k]; sub[3 * q + 1] = dirs[3 * k + 1]; sub[3 * q + 2] = dirs[3 * k + 2]; });
    world.raycastBatch!(eye, sub, ids.length, farM, sd, sn);
    ids.forEach((k, q) => { dist[k] = sd[q]; ny[k] = sn[q]; });
  };
  if (!world.raycastBatch) dist.fill(Infinity);
  else if (opts.full) cast(Array.from({ length: n }, (_, k) => k));
  else {
    const coarse: number[] = [];
    for (let j = 0; j < LOOK_H; j += 2) for (let i = 0; i < LOOK_W; i += 2) coarse.push(j * LOOK_W + i);
    cast(coarse);
    const refine: number[] = [];
    for (let j = 0; j < LOOK_H; j += 2) {
      for (let i = 0; i < LOOK_W; i += 2) {
        const k00 = j * LOOK_W + i, k10 = k00 + 2, k01 = k00 + 2 * LOOK_W, k11 = k01 + 2;
        const others = [k00 + 1, k00 + LOOK_W, k00 + LOOK_W + 1];
        if (i + 2 >= LOOK_W || j + 2 >= LOOK_H) { refine.push(...others); continue; } // no full set of corners at the right and bottom edges
        const d = [dist[k00], dist[k10], dist[k01], dist[k11]], flat = [ny[k00], ny[k10], ny[k01], ny[k11]].map((v) => v > 0.7);
        const miss = d.filter((v) => v === Infinity).length;
        let coherent: boolean;
        if (miss === 4) coherent = true;
        else if (miss > 0 || flat.some((f) => f !== flat[0])) coherent = false;
        else {
          const mean = (d[0] + d[1] + d[2] + d[3]) / 4;
          coherent = Math.max(...d) - Math.min(...d) <= 0.3 * mean && Math.abs(d[0] + d[3] - d[1] - d[2]) <= 0.03 * mean + 0.03;
        }
        if (!coherent) { refine.push(...others); continue; }
        dist[others[0]] = miss === 4 ? Infinity : (d[0] + d[1]) / 2;
        dist[others[1]] = miss === 4 ? Infinity : (d[0] + d[2]) / 2;
        dist[others[2]] = miss === 4 ? Infinity : (d[0] + d[1] + d[2] + d[3]) / 4;
        for (const o of others) ny[o] = ny[k00];
      }
    }
    cast(refine);
  }
  const d: Vec3 = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    d[0] = dirs[3 * k]; d[1] = dirs[3 * k + 1]; d[2] = dirs[3 * k + 2];
    let best = farM, cls: number = LOOK_CLASSES.sky;
    if (dist[k] < best) { best = dist[k]; cls = ny[k] > 0.7 ? LOOK_CLASSES.floor : LOOK_CLASSES.wall; }
    for (const r of scene.doors) { const t = rayDoor(eye, d, r); if (t <= best + DOOR_SLACK_M) { best = Math.min(best, t); cls = LOOK_CLASSES.door; } }
    for (const s of scene.spheres) { const t = raySphere(eye, d, s); if (t < best) { best = t; cls = s.cls; } }
    for (const b of scene.bodies) { const t = rayCylinder(eye, d, b); if (t < best) { best = t; cls = LOOK_CLASSES.body; } }
    if (cls !== LOOK_CLASSES.sky) {
      depthMm[k] = Math.min(LOOK_NO_HIT - 1, Math.round(best * 1000));
      classes[k] = cls;
    }
  }
  return { width: LOOK_W, height: LOOK_H, depthMm, classes };
}
