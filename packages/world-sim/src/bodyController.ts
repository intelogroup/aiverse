// bodyController.ts — the fast, deterministic body layer between a crowd agent and its figure.
//
// The mind (an LLM, seconds per decision, costs credits) only ever issues sparse intents. Everything
// that has to look continuous runs here, locally, at frame rate: O(1) per agent, no allocation, no
// network and no model call. That is also what keeps "realtime" cheap — 1000 ticking bodies cost CPU,
// never credits (see bodyController.test.ts for the measured cost).
//
// What it fixes (measured against the legacy pipeline in the same test):
//   * heading used to snap to the velocity direction, so a reversal flipped the body 180° in one frame;
//   * a stop-and-turn spun the figure on the spot in Idle, like a turntable;
//   * walk playback was clamped to 0.7x, so feet slid at low speed.
// Now facing turns at a capped rate, speed is throttled by how far the body is from where it is going,
// a large turn from standstill plays the catalog's turn clip with the heading following the clip's own
// pelvis rotation (so the feet stay planted), and Idle/Walk blend by speed.
//
// Three-free and DOM-free, like locomotion.ts and embody.ts. heading = atan2(vx, vz); positive heading
// is a LEFT turn for the cast rig (it faces +Z, its left is +X).

export const DEG = Math.PI / 180;

export interface TurnClipDef {
  name: "TurnLeft90" | "TurnRight90";
  duration: number; // s, baked clip length
  net: number; // rad, signed heading change over the whole clip (+ = left)
  /** Fraction of `net` reached at 25 uniform time samples (0..1): the clip's own pelvis yaw, measured in three.js space. */
  curve: number[];
}

/**
 * Both turn clips are authored facing ~62 degrees off the Idle pose (pelvis yaw -58.7 deg at t = 0 against Idle's
 * +3.4 deg, measured in three.js space), then swing +90 / -90 from there. The figure must cancel that offset too,
 * or the body visibly twists as the clip fades in. baked = YAW0 + yaw is the pelvis yaw the pose carries.
 */
export const TURN_YAW0 = -62.1 * DEG;

// Measured 2026-11-06 from cast-bodyblock.glb (pelvis yaw from the two upper-leg joints, three.js space).
const LEFT_DEG = [0, 0.08, 0.72, 3.99, 10.99, 20.3, 26.43, 31.61, 38.51, 46.38, 53.81, 60.04, 66.44, 73.17, 79.31, 83.21, 84.8, 86.66, 87.61, 87.66, 87.83, 88.15, 89.45, 90.43, 90.26];
const RIGHT_DEG = [0, 0.02, -0.57, -3.46, -10.2, -20.73, -28.99, -33.07, -37.38, -43.3, -50.72, -58, -63.81, -68.33, -72.27, -76.49, -80.43, -84.26, -88.36, -91.87, -93.51, -93.44, -92.44, -91.45, -90.46];
const norm = (a: number[]): number[] => a.map((d) => d / a[a.length - 1]);
export const TURN_LEFT: TurnClipDef = { name: "TurnLeft90", duration: 1.8667, net: 90.26 * DEG, curve: norm(LEFT_DEG) };
export const TURN_RIGHT: TurnClipDef = { name: "TurnRight90", duration: 1.6333, net: -90.46 * DEG, curve: norm(RIGHT_DEG) };

/** Fraction of the clip's rotation completed at normalised clip time t in [0, 1] (linear between samples). */
export function turnProgress(def: TurnClipDef, t: number): number {
  const n = def.curve.length - 1;
  const x = Math.min(1, Math.max(0, t)) * n;
  const i = Math.min(n - 1, Math.floor(x));
  return def.curve[i] + (def.curve[i + 1] - def.curve[i]) * (x - i);
}

export interface BodyParams {
  /** Max facing rate while moving or making small corrections, rad/s. */
  turnRate: number;
  /** Heading error beyond which a body that has (nearly) stopped turns in place with the clip, rad. Below it a
   * rotation of a few degrees reads as Idle sway; above it Idle legs would visibly spin like a turntable. */
  inPlaceErr: number;
  /** Error below which speed is untouched / beyond which the body must stop, rad. */
  fullSpeedErr: number;
  stopErr: number;
  /** Floor of the speed scale while turning on the move (a walking arc, not a halt). */
  minMoveScale: number;
  /** Speed below which a body counts as stopped (turn in place may start), m/s. */
  stopSpeed: number;
  /** Speed below which the crowd's velocity direction means nothing (idle), m/s. */
  moveSpeed: number;
  /** Turn clip playback rate: 1 = as authored, >1 = hurried ("startled") turn. The feet stay planted at any rate. */
  turnUrgency: number;
  /** Idle->Walk weight ramps over this speed band, m/s. */
  walkWeightFrom: number;
  walkWeightTo: number;
}

export const DEFAULT_BODY_PARAMS: BodyParams = {
  turnRate: 200 * DEG,
  inPlaceErr: 70 * DEG,
  fullSpeedErr: 30 * DEG,
  stopErr: 110 * DEG,
  minMoveScale: 0.25,
  stopSpeed: 0.25,
  moveSpeed: 0.1,
  turnUrgency: 1.4,
  walkWeightFrom: 0.1,
  walkWeightTo: 0.4,
};

export interface BodyInput {
  /** Crowd velocity, m/s (XZ) and its magnitude. */
  vx: number;
  vz: number;
  speed: number;
  /** Explicit facing wish when not moving (a face skill, a look-at target); null = keep facing. */
  intent: number | null;
  /** This body's natural Walk speed, m/s (bodies.ts walkSpeed). */
  walkSpeed: number;
}

export interface BodyOutput {
  /** Render heading for the figure group (rad). */
  heading: number;
  /** Multiply the crowd agent's cruise speed by this (0 = stop and turn). */
  speedScale: number;
  /** Set while a turn clip owns the legs: normalised clip time and which clip. The figure must set the
   * clip's time from `t`, rotate the skeleton root by -`baked` (the pelvis yaw the pose carries: TURN_YAW0 + yaw,
   * scaled by the clip's blend weight) and the group by `heading`. */
  turn: { clip: TurnClipDef["name"]; t: number; yaw: number; baked: number } | null;
  /** Idle/Walk blend weight (0..1) and Walk playback rate. */
  walkWeight: number;
  walkTimeScale: number;
}

export interface BodyState {
  heading: number;
  turn: { def: TurnClipDef; t: number; start: number; remaining: number } | null;
  scale: number;
}

export function newBodyState(heading = 0): BodyState {
  return { heading, turn: null, scale: 1 };
}

export const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Speed multiplier for a heading error: untouched when roughly aligned, a halt when facing away. */
export function speedScaleForError(absErr: number, p: BodyParams = DEFAULT_BODY_PARAMS): number {
  if (absErr <= p.fullSpeedErr) return 1;
  if (absErr >= p.stopErr) return 0;
  const k = (absErr - p.fullSpeedErr) / (p.stopErr - p.fullSpeedErr);
  return Math.max(p.minMoveScale, 1 - k * (1 - p.minMoveScale)) * (k > 0.85 ? 1 - (k - 0.85) / 0.15 : 1);
}

export function stepBody(s: BodyState, i: BodyInput, dt: number, p: BodyParams = DEFAULT_BODY_PARAMS): BodyOutput {
  const moving = i.speed > p.moveSpeed;
  const walkWeight = smooth(p.walkWeightFrom, p.walkWeightTo, i.speed);
  const walkTimeScale = walkWeight > 0.5 ? clamp(i.speed / i.walkSpeed, 0.85, 1.3) : 1;

  // 1) A turn clip owns heading and legs until it ends: it plays out whole (a quarter turn is ~1.3 s at urgency 1.4).
  if (s.turn) {
    const tn = s.turn;
    tn.t += (dt * p.turnUrgency) / tn.def.duration;
    if (tn.t >= 1) {
      s.heading = wrapAngle(tn.start + tn.def.net);
      if (tn.remaining > 0) {
        s.turn = { def: tn.def, t: 0, start: s.heading, remaining: tn.remaining - 1 };
      } else {
        s.turn = null;
        s.scale = 0;
        return { heading: s.heading, speedScale: 0, turn: null, walkWeight, walkTimeScale };
      }
    }
    const cur = s.turn!;
    const yaw = cur.def.net * turnProgress(cur.def, cur.t);
    s.heading = wrapAngle(cur.start + yaw);
    return { heading: s.heading, speedScale: 0, turn: { clip: cur.def.name, t: cur.t, yaw, baked: TURN_YAW0 + yaw }, walkWeight: 0, walkTimeScale: 1 };
  }

  // 2) Free: chase the direction of travel (or the explicit wish) at a capped rate.
  const desired = moving ? Math.atan2(i.vx, i.vz) : i.intent;
  if (desired === null) {
    s.scale = 1;
    return { heading: s.heading, speedScale: 1, turn: null, walkWeight, walkTimeScale };
  }
  const err = wrapAngle(desired - s.heading);
  const abs = Math.abs(err);

  if (abs > p.inPlaceErr && i.speed < p.stopSpeed) {
    const quarters = abs > 135 * DEG ? 2 : 1; // 180 = two quarter turns (the catalog has 90s only)
    const def = err > 0 ? TURN_LEFT : TURN_RIGHT;
    s.turn = { def, t: 0, start: s.heading, remaining: quarters - 1 };
    s.scale = 0;
    return { heading: s.heading, speedScale: 0, turn: { clip: def.name, t: 0, yaw: 0, baked: TURN_YAW0 }, walkWeight: 0, walkTimeScale: 1 };
  }

  s.heading = wrapAngle(s.heading + clamp(err, -p.turnRate * dt, p.turnRate * dt));
  // Only throttle a body that is actually going somewhere; a stationary one with a small error just turns.
  s.scale = moving ? speedScaleForError(abs, p) : 1;
  return { heading: s.heading, speedScale: s.scale, turn: null, walkWeight, walkTimeScale };
}
