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

/** Class codes in the class image (the legend sent with every look). Doors are collision gaps or walls here, so they have no class. */
export const LOOK_CLASSES = { sky: 0, floor: 1, wall: 2, seat: 3, prop: 4, body: 5 } as const;
export const LOOK_LEGEND: Record<number, string> = Object.fromEntries(Object.entries(LOOK_CLASSES).map(([k, v]) => [v, k]));

export interface LookSphere { c: Vec3; r: number; cls: number }
/** A body: a vertical cylinder from y0 to y1 around (x, z). */
export interface LookCylinder { x: number; z: number; y0: number; y1: number; r: number }
export interface LookScene { spheres: LookSphere[]; bodies: LookCylinder[] }

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

/**
 * Cast a LOOK_W x LOOK_H grid of rays from `eye`, the camera facing `heading` (walker convention: forward is (sin h, cos h)).
 * Columns run left to right with increasing bearing, the same sign `observe` uses.
 */
export function renderLook(world: World, eye: Vec3, heading: number, scene: LookScene, farM = LOOK_FAR_M): LookResult {
  const depthMm = new Uint16Array(LOOK_W * LOOK_H).fill(LOOK_NO_HIT), classes = new Uint8Array(LOOK_W * LOOK_H);
  const tanH = Math.tan((LOOK_HFOV_DEG * Math.PI) / 360), tanV = tanH * (LOOK_H / LOOK_W);
  const fx = Math.sin(heading), fz = Math.cos(heading), rx = Math.cos(heading), rz = -Math.sin(heading);
  // Directions first, so the world can cull its colliders once for all 9,216 rays.
  const n = LOOK_W * LOOK_H, dirs = new Float32Array(n * 3), dist = new Float32Array(n), ny = new Float32Array(n);
  for (let j = 0; j < LOOK_H; j++) {
    const v = (1 - ((j + 0.5) / LOOK_H) * 2) * tanV;
    for (let i = 0; i < LOOK_W; i++) {
      const u = (((i + 0.5) / LOOK_W) * 2 - 1) * tanH, k = j * LOOK_W + i;
      const x = fx + rx * u, y = v, z = fz + rz * u, m = Math.hypot(x, y, z);
      dirs[3 * k] = x / m; dirs[3 * k + 1] = y / m; dirs[3 * k + 2] = z / m;
    }
  }
  if (world.raycastBatch) world.raycastBatch(eye, dirs, n, farM, dist, ny);
  else dist.fill(Infinity);
  const d: Vec3 = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    d[0] = dirs[3 * k]; d[1] = dirs[3 * k + 1]; d[2] = dirs[3 * k + 2];
    let best = farM, cls: number = LOOK_CLASSES.sky;
    if (dist[k] < best) { best = dist[k]; cls = ny[k] > 0.7 ? LOOK_CLASSES.floor : LOOK_CLASSES.wall; }
    for (const s of scene.spheres) { const t = raySphere(eye, d, s); if (t < best) { best = t; cls = s.cls; } }
    for (const b of scene.bodies) { const t = rayCylinder(eye, d, b); if (t < best) { best = t; cls = LOOK_CLASSES.body; } }
    if (cls !== LOOK_CLASSES.sky) {
      depthMm[k] = Math.min(LOOK_NO_HIT - 1, Math.round(best * 1000));
      classes[k] = cls;
    }
  }
  return { width: LOOK_W, height: LOOK_H, depthMm, classes };
}
