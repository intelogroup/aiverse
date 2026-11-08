// walkTouch.ts — the human touch layer's pure logic (Mobile Phase 1).
//
// The plan (docs/ui-review/MOBILE-PLAN.md §1): touch is a NEW input
// source writing the SAME abstract intent the keyboard writes
// ({forward, strafe, turn, run, look} — walker.ts), never a walker
// rewrite. This module is the three-free, DOM-free half of that layer:
//
//   - gesture classification (the corpus ambiguity rule: a touch that
//     moves <10 px and lifts within ~250 ms is a tap; beyond that the
//     same touch is a look-drag — nothing commits to a hidden binary),
//   - the floating stick's vector math (deadzone, clamp, push-past-85%
//     = run),
//   - TouchWalkSource: the shared mutable intent source CityWalker
//     merges next to the keys (the WalkClipOverride pattern),
//   - the chip derivations (which door clip the chip may offer, the
//     interact chip's human label) so the DOM layer stays declarative.
//
// TouchWalkLayer.tsx owns the DOM/React half; CityWalker.tsx consumes
// the source. Desktop input never touches any of this.

import type { WalkInput } from "./walker";
import {
  TEA_DOOR_ORIGIN,
  TEA_REQUEST_RANGE,
  teaStandPose,
  type TeaDoorState,
  type TeaSessionPhase,
} from "./teaDoor";
import type { WalkDoorClip } from "./walkOverride";
import type { InteractableDef } from "./interactables";

/** A touch that moves less than this (px) may still be a tap. */
export const TAP_MAX_MOVE_PX = 10;
/** A touch that lifts within this (ms) may still be a tap. */
export const TAP_MAX_MS = 250;
/** Stick throw (0..1 of full) past which the bot runs. */
export const STICK_RUN_THRESHOLD = 0.85;
/** Stick deadzone (0..1 of full throw): below it the bot stands. */
export const STICK_DEADZONE = 0.14;
/** Full stick throw in px (touch-down origin to full speed). */
export const STICK_RADIUS_PX = 52;
/** Look-drag sensitivity, rad per px (the mouse uses 0.0022; a thumb
 * drag covers fewer px, so touch runs hotter — Settings gets the
 * slider in Phase 4). */
export const LOOK_SENS = 0.0042;

/**
 * Mobile Phase 4: the Settings look prefs (comfort.ts) — a
 * sensitivity multiplier and an invert-Y flip, synced in by the
 * shell. Defaults are the Phase 1 behaviour, bit for bit.
 */
let lookPrefs = { sensitivity: 1, invertY: false };
export function setLookPrefs(p: { sensitivity: number; invertY: boolean }): void {
  lookPrefs = { sensitivity: p.sensitivity, invertY: p.invertY };
}
/** Share of the stage width (from the left) where a touch-down plants
 * the stick; the rest of the stage is look country. Landscape phones
 * are two-handed with a shorter reach, so the zone narrows. */
export const stickZoneFraction = (landscape: boolean): number =>
  landscape ? 0.35 : 0.45;

/** The corpus ambiguity rule: tap vs look-drag from the raw track. */
export function classifyTouchGesture(
  dxPx: number,
  dyPx: number,
  dtMs: number,
): "tap" | "drag" {
  return Math.hypot(dxPx, dyPx) < TAP_MAX_MOVE_PX && dtMs < TAP_MAX_MS
    ? "tap"
    : "drag";
}

export interface StickVector {
  /** -1..1, +1 = ahead (screen up). */
  forward: number;
  /** -1..1, +1 = to the right (screen right). */
  strafe: number;
  /** 0..1 throw after the deadzone rescale (0 = standing). */
  magnitude: number;
}

/**
 * Stick displacement (px from the touch-down origin, screen coords,
 * y down) → walker intent axes. Direction is preserved, magnitude is
 * the throw rescaled out of the deadzone so speed ramps smoothly
 * from the deadzone edge to full throw.
 */
export function stickVector(
  dxPx: number,
  dyPx: number,
  radiusPx: number = STICK_RADIUS_PX,
): StickVector {
  const d = Math.hypot(dxPx, dyPx);
  if (d < 1e-6) return { forward: 0, strafe: 0, magnitude: 0 };
  const raw = Math.min(1, d / radiusPx);
  const magnitude =
    raw <= STICK_DEADZONE ? 0 : (raw - STICK_DEADZONE) / (1 - STICK_DEADZONE);
  const ux = dxPx / d;
  const uy = dyPx / d;
  const z = (v: number): number => (v === 0 ? 0 : v); // never leak -0 into an intent
  return { forward: z(-uy * magnitude), strafe: z(ux * magnitude), magnitude };
}

/**
 * The touch intent source: one per walk session, created by the host
 * (GlbWorld), written by TouchWalkLayer's surface handlers, read by
 * CityWalker's frame loop. Plain mutable fields, no events — the
 * frame loop polls, exactly like the keyboard's Held record.
 */
export class TouchWalkSource {
  /** The stick's current vector (zeros while no stick touch is down). */
  private vec: StickVector = { forward: 0, strafe: 0, magnitude: 0 };
  private stickDown = false;
  /** Run toggle chip state: while on, any stick deflection runs. */
  runToggle = false;
  private yawAcc = 0;
  private pitchAcc = 0;

  /** A stick touch is down and steering. */
  get stickActive(): boolean {
    return this.stickDown;
  }

  /** Stick touch-down (origin planted under the thumb). */
  beginStick(): void {
    this.stickDown = true;
    this.vec = { forward: 0, strafe: 0, magnitude: 0 };
  }

  /** Stick drag: displacement in px from the touch-down origin. */
  moveStick(dxPx: number, dyPx: number): void {
    if (!this.stickDown) return;
    this.vec = stickVector(dxPx, dyPx);
  }

  /** Stick lifted: the bot stands (keys, if any, still apply). */
  endStick(): void {
    this.stickDown = false;
    this.vec = { forward: 0, strafe: 0, magnitude: 0 };
  }

  /** Look-drag delta (px since the last move event). */
  addLook(dxPx: number, dyPx: number): void {
    this.yawAcc += dxPx * LOOK_SENS * lookPrefs.sensitivity;
    this.pitchAcc += (lookPrefs.invertY ? dyPx : -dyPx) * LOOK_SENS * lookPrefs.sensitivity;
  }

  /** Consume the accumulated look (the frame loop calls this once). */
  consumeLook(): { yaw: number; pitch: number } {
    const out = { yaw: this.yawAcc, pitch: this.pitchAcc };
    this.yawAcc = 0;
    this.pitchAcc = 0;
    return out;
  }

  /** This frame's stick intent (active = the stick owns move axes). */
  intent(): { forward: number; strafe: number; run: boolean; active: boolean } {
    return {
      forward: this.vec.forward,
      strafe: this.vec.strafe,
      run: this.runToggle || this.vec.magnitude >= STICK_RUN_THRESHOLD,
      active: this.stickDown,
    };
  }

  /** Walk mode ended: forget everything (no latched run, no drift). */
  reset(): void {
    this.endStick();
    this.runToggle = false;
    this.yawAcc = 0;
    this.pitchAcc = 0;
  }
}

/**
 * Merge a touch source into a keyboard-produced intent. While the
 * stick is down it owns the move axes (a thumb already down beats a
 * key nobody is holding); run latches from either source; look is
 * merged by the caller (it is an accumulator, not an axis). An absent
 * or idle source returns the base intent untouched — the desktop path
 * is bit-identical.
 */
export function mergeTouchIntent(
  base: WalkInput,
  src: TouchWalkSource | undefined,
): WalkInput {
  if (!src) return base;
  const ti = src.intent();
  if (!ti.active && !ti.run) return base;
  return {
    ...base,
    forward: ti.active ? ti.forward : base.forward,
    strafe: ti.active ? ti.strafe : base.strafe,
    run: base.run || ti.run,
  };
}

/**
 * The door chip's offer: the clip the Tea House door session may
 * start for a player at (x, z), or null when no chip shows. The chip
 * exists only where the request can succeed — door shut, no session
 * running, the player within request range of the stand pose on
 * THEIR side of the door plane (the plan's I2 fix: no global buttons
 * that can only fail).
 */
export function doorChipClip(
  x: number,
  z: number,
  state: TeaDoorState,
  phase: TeaSessionPhase,
): WalkDoorClip | null {
  if (state !== "closed" || phase !== "idle") return null;
  const clips: WalkDoorClip[] = ["OpenDoorInwards", "OpenDoorOutwards"];
  for (const clip of clips) {
    const pose = teaStandPose(clip);
    if ((z - TEA_DOOR_ORIGIN.z) * (pose.z - TEA_DOOR_ORIGIN.z) <= 0) continue;
    if (Math.hypot(x - pose.x, z - pose.z) <= TEA_REQUEST_RANGE) return clip;
  }
  return null;
}

/** The interact chip's label, in human words (never a clip name). */
export function interactChipText(def: InteractableDef, on: boolean): string {
  return `Turn ${def.label.toLowerCase()} ${on ? "off" : "on"}`;
}
