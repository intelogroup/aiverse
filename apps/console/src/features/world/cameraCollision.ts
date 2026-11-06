/**
 * Orbit-camera collision (City 3), pure math. The CameraCollider casts one ray from the orbit target towards the
 * camera; these helpers turn the first hit into the distance/position the camera may actually sit at.
 */

export type Vec3 = readonly [number, number, number];

/** Default gap kept between the camera and the surface it would otherwise touch (m). */
export const COLLIDE_PAD = 0.35;
/** Closest the camera is pulled towards the target by a wall right behind it (m). Collision may beat minDistance. */
export const COLLIDE_FLOOR = 0.6;
/** Exponential rate the camera eases back out once the obstruction clears (1/s). Inwards is a snap. */
export const COLLIDE_OUT_RATE = 6;

/**
 * Allowed target->camera distance for a desired distance `len` and the first hit along that ray (`hitDist`, null or
 * non-finite = no hit): `max(min(hitDist - pad, len), floor)`, never more than `len`.
 */
export function resolveDistance(len: number, hitDist: number | null, pad = COLLIDE_PAD, floor = COLLIDE_FLOOR): number {
  if (!(len > 0)) return 0;
  if (hitDist === null || !Number.isFinite(hitDist)) return len;
  return Math.min(len, Math.max(Math.min(hitDist - pad, len), floor));
}

/** The clamped camera position along target->desired (see resolveDistance). Zero-length input returns `desired`. */
export function resolveCamera(target: Vec3, desired: Vec3, hitDist: number | null, pad = COLLIDE_PAD, floor = COLLIDE_FLOOR): [number, number, number] {
  const dx = desired[0] - target[0], dy = desired[1] - target[1], dz = desired[2] - target[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return [desired[0], desired[1], desired[2]];
  const k = resolveDistance(len, hitDist, pad, floor) / len;
  return [target[0] + dx * k, target[1] + dy * k, target[2] + dz * k];
}

/**
 * Next shown distance: snap in to `allowed` when it is closer than what is shown (never a frame inside a wall),
 * otherwise ease out towards it at `rate`.
 */
export function stepDistance(shown: number, allowed: number, dt: number, rate = COLLIDE_OUT_RATE): number {
  if (allowed <= shown) return allowed;
  const next = shown + (allowed - shown) * (1 - Math.exp(-rate * Math.max(dt, 0)));
  return allowed - next < 1e-3 ? allowed : next;
}
