// cameraRig.ts — Embody v0 head-camera math (SPIKE, branch tmp/embody-v0).
//
// The console side of "give the agent a body": when the owner rides
// along, the camera is not a rig trick — it sits where the bot's head
// is and faces where the bot faces, so turning stays an agent action
// (a `face` skill changes what the owner sees). Three modes:
//
//   wide   — the existing spectator camera + OrbitControls (unchanged;
//            this module only eases the FOV back to the house 45°).
//   follow — a trail camera behind/above the selected bot.
//   ride   — first-person: camera at head height, looking along the
//            bot's heading, FOV opened to 90° (human-like cone).
//
// Pure math only (three-free, same discipline as embody.ts): the R3F
// component in GlbWorld.tsx feeds it crowd frames + render overrides
// and applies the results to the camera. Positions are world [x, y, z];
// heading follows the locomotion convention (atan2(vx, vz); facing
// vector = (sin h, cos h)).

import { angleDelta, type FigureOverride } from "./embody";
import type { AgentFrame } from "./locomotion";

export type CameraMode = "wide" | "follow" | "ride";
export type Vec3 = [number, number, number];

export const FOV_WIDE = 45;
export const FOV_RIDE = 90;
/** Eye height above the feet for a standing bot (bot is 1.25 m tall). */
export const HEAD_HEIGHT = 1.15;
/** Eye height above the seat surface for a seated bot. */
export const SEAT_HEAD_HEIGHT = 1.0;
/** Follow camera: metres behind the bot, metres above its feet. */
export const FOLLOW_BACK = 3.2;
export const FOLLOW_UP = 1.9;
/** Follow camera aims at the bot's chest, not its feet. */
export const FOLLOW_LOOK_UP = 0.9;
/** How far ahead the ride camera gazes (level, along the heading). */
export const RIDE_LOOK_AHEAD = 4;
/**
 * How far in FRONT of the body centre the ride camera sits — at the face
 * plane, like eyes. At the centre the bot's own head shell fills the
 * frame (Jim, riding Amara: "the view is barred by her head — it should
 * be like my eyes seeing"). The ridden figure's head is also hidden in
 * ride mode (CastFigure `headless`); the offset alone clears the shell
 * even mid-crossfade.
 */
export const EYE_FORWARD = 0.22;

/** Smoothing rates (1/s) for the exponential dampers in the rig. */
export const DAMP_POS_RIDE = 12;
export const DAMP_POS_FOLLOW = 4;
export const DAMP_LOOK = 10;
export const DAMP_HEADING = 5;
export const DAMP_FOV = 8;

/** Frame-rate independent exponential smoothing factor for one step. */
export function dampFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * Math.max(0, dt));
}

/** Move `current` toward `target` by one damped step. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * dampFactor(rate, dt);
}

/**
 * Damp an angle toward a target the short way around the circle
 * (reusing embody's angleDelta), normalized back into (-PI, PI] so a
 * smoothed heading never accumulates whole turns.
 */
export function dampAngle(current: number, target: number, rate: number, dt: number): number {
  const v = current + angleDelta(current, target) * dampFactor(rate, dt);
  let n = v % (Math.PI * 2);
  if (n > Math.PI) n -= Math.PI * 2;
  if (n <= -Math.PI) n += Math.PI * 2;
  return n;
}

/** Where the selected bot's body is this frame, in world terms. */
export interface BotView {
  x: number;
  z: number;
  heading: number;
  /** World Y of the figure's feet (ground, or ground + seat lift). */
  feetY: number;
  seated: boolean;
}

/**
 * Resolve the bot's render pose from the crowd frame, honoring the
 * Embody override: while sitting/mounting, the figure (and therefore
 * the camera) sits at the anchor, not at the crowd body's approach
 * point — the same transform CastFigure applies.
 */
export function botView(
  frame: AgentFrame | null,
  override: FigureOverride | null,
  groundY: number,
): BotView | null {
  if (override) {
    return {
      x: override.position[0],
      z: override.position[1],
      heading: override.heading,
      feetY: groundY + override.y,
      seated: true,
    };
  }
  if (!frame) return null;
  return {
    x: frame.position[0],
    z: frame.position[1],
    heading: frame.heading,
    feetY: groundY,
    seated: false,
  };
}

/** First-person pose: camera at the eyes, gaze level along `heading`. */
export function rideTarget(view: BotView, heading: number): { cam: Vec3; look: Vec3 } {
  const head = view.seated ? SEAT_HEAD_HEIGHT : HEAD_HEIGHT;
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  const cam: Vec3 = [view.x + fx * EYE_FORWARD, view.feetY + head, view.z + fz * EYE_FORWARD];
  const look: Vec3 = [cam[0] + fx * RIDE_LOOK_AHEAD, cam[1], cam[2] + fz * RIDE_LOOK_AHEAD];
  return { cam, look };
}

/** Trail pose: camera behind/above the bot, aimed at its chest. */
export function followTarget(view: BotView): { cam: Vec3; look: Vec3 } {
  const fx = Math.sin(view.heading);
  const fz = Math.cos(view.heading);
  const cam: Vec3 = [
    view.x - fx * FOLLOW_BACK,
    view.feetY + FOLLOW_UP,
    view.z - fz * FOLLOW_BACK,
  ];
  const look: Vec3 = [view.x, view.feetY + FOLLOW_LOOK_UP, view.z];
  return { cam, look };
}
