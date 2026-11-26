// interiorStage.ts — the look inside City 3's rooms (three-free math; the rig lives in glbStage).
//
// The stage is authored for noon outdoors (KeyLight + sky env). Inside a room the roof eats the
// key, AgX exposure 1.1 + env 0.6 leaves the interiors nearly black (measured: loft entry p50 18
// against the Cycles reference 147-166 at the same spawn). This derives an interior look from the
// room itself: sun from the room's street-facing side at the authoring elevation (22 deg, the
// taste-lab sun), a static shadow box fitted to the room rect (crisper contact shadows than the
// +-60 m walking box at 6 cm/texel), and exposure/env calibrated to bring the interior into the
// Cycles p50 band without touching the world outside.
//
// All inputs are plain data so vitest covers it (see interiorStage.test.ts); the Blender-side
// calibration (Cycles sun 22 deg az -60, warm fill, exposure 0) lives in docs/procedural-city/27.
import type { City3Room } from "./city3";

/** The Cycles-authored interior sun: elevation above the horizon, in degrees. */
export const INTERIOR_SUN_ELEVATION_DEG = 22;
/** The sun sits this far (degrees) off the room's street-facing normal, toward +x. */
export const INTERIOR_SUN_SPREAD_DEG = 30;
/** Interior shadow box: room diagonal of the largest interior plus margin (m). */
export const INTERIOR_SHADOW_HALF = 14;
/** Calibrated from the loft A/B (2026-11-25): exposure/env that lift the interior into the
 *  Cycles pull (before: 1.1 / 0.6 gave entry p50 18; after lands the three fixed spawns in
 *  the Cycles p50 band without touching the outdoor street control). */
export const INTERIOR_EXPOSURE = 2.4;
export const INTERIOR_ENV_INTENSITY = 1.5;
export const INTERIOR_SUN_INTENSITY = 3.0;
/** How far inside a room's rect the camera must be before the interior look engages (m).
 *  0.4, not 1.0: walls are solid so the lip only guards doorways, and the loft entry spawn sits
 *  ~1.0 m inside the rect — a 1.0 margin left 4 cm to spare and engagement dropped on jitter
 *  (measured 2026-11-25: the rig never fired at the entry spawn). */
export const INTERIOR_ENGAGE_MARGIN = 0.4;

export interface InteriorLook {
  exposure: number;
  envIntensity: number;
  sunIntensity: number;
  /** Unit vector, direction TO the sun, three.js space (three.js +Z faces the room's S/front). */
  sunDir: [number, number, number];
  /** Shadow map box half-size (m) fitted to the room. */
  shadowHalf: number;
  /** Box centre in three.js space (room centre, 1.2 m eye height). */
  shadowCenter: [number, number, number];
}

/** Null outside every room rect (shrunk by the engage margin). */
export function insideRoom(rooms: readonly City3Room[], x: number, z: number): City3Room | null {
  for (const r of rooms) {
    const [minX, minZ, maxX, maxZ] = r.rect;
    const m = INTERIOR_ENGAGE_MARGIN;
    if (x >= minX + m && x <= maxX - m && z >= minZ + m && z <= maxZ - m) return r;
  }
  return null;
}

/** Sun from the room's street-facing side: elevation 22 deg, 30 deg off the front normal. */
export function interiorSunDir(room: Pick<City3Room, "front">): [number, number, number] {
  // Front vector in three.js space (city3.ts: S faces -Y blender = +Z three).
  const front: Record<City3Room["front"], [number, number]> = { S: [0, 1], N: [0, -1], E: [1, 0], W: [-1, 0] };
  const [fx, fz] = front[room.front];
  const el = (INTERIOR_SUN_ELEVATION_DEG * Math.PI) / 180;
  const sp = (INTERIOR_SUN_SPREAD_DEG * Math.PI) / 180;
  // spread the azimuth off the front normal toward +x, keep unit length rolling off outdoors
  const ax = fx * Math.cos(sp) + Math.sin(sp);
  const az = fz * Math.cos(sp);
  const horiz = Math.hypot(ax, az) || 1;
  const dir: [number, number, number] = [
    (ax / horiz) * Math.cos(el),
    Math.sin(el),
    (az / horiz) * Math.cos(el),
  ];
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  return [dir[0] / len, dir[1] / len, dir[2] / len];
}

/** The full interior profile for a room: look + static shadow box on the room rect. */
export function interiorLook(room: City3Room): InteriorLook {
  const [minX, minZ, maxX, maxZ] = room.rect;
  const half = Math.max(maxX - minX, maxZ - minZ) / 2 + 2;
  return {
    exposure: INTERIOR_EXPOSURE,
    envIntensity: INTERIOR_ENV_INTENSITY,
    sunIntensity: INTERIOR_SUN_INTENSITY,
    sunDir: interiorSunDir(room),
    shadowHalf: Math.min(half, INTERIOR_SHADOW_HALF),
    shadowCenter: [(minX + maxX) / 2, 1.2, (minZ + maxZ) / 2],
  };
}
