// bodies.ts — the per-body registry for cast figures.
//
// A "body" is one rigged GLB plus the facts the console needs to wear
// it: where its hips ride (the embody seat drop is computed from the
// WEARER's hips, not a global constant) and the clip names its catalog
// carries. The five CORE clips — Idle, Walk, SittingTalking, SitDown,
// StandUp — are the ones skills and clip selection are wired to; the
// full 45-clip catalog every body ships lives in clips.ts. Bodies
// never branch per clip; only the measurements do.
//
// Three-free and DOM-free, same discipline as embody.ts.

import { CAST_HIPS_Y, type SitPhase } from "./embody";

export interface BodyDef {
  id: string;
  /** GLB under the console's public assets. */
  url: string;
  /** Standing hips height of this rig, m — measured in Blender. */
  hipsY: number;
  /**
   * Natural ground speed of this body's Walk cycle, m/s — the speed
   * at which the baked root motion travels (cycle distance / cycle
   * duration, measured in Blender from the stance feet). CastFigure
   * scales Walk playback by crowd speed / walkSpeed so the feet track
   * the ground, and extracts the clip's root translation so the crowd
   * keeps position authority.
   */
  walkSpeed: number;
  clips: { idle: string; walk: string; sitTalk: string; sitDown: string; standUp: string };
}

const CATALOG = { idle: "Idle", walk: "Walk", sitTalk: "SittingTalking", sitDown: "SitDown", standUp: "StandUp" };

/** The shared Body Block body every roster member wears by default. */
export const BODY_CAST: BodyDef = {
  id: "cast",
  url: "/assets/cast-bodyblock.glb",
  hipsY: CAST_HIPS_Y,
  // Walk bake 2026-11-05: cycle 1.0203 m / 1.1667 s (stance-measured).
  walkSpeed: 0.8746,
  clips: CATALOG,
};

/**
 * Summer — Jim's character (Sitting_small_0_ex78.fbx), a 33-bone
 * Mixamo rig scaled to cast height. Hips measured in Blender from the
 * exported cast-summer.glb at rest.
 */
export const SUMMER_HIPS_Y = 0.7854; // m

export const BODY_SUMMER: BodyDef = {
  id: "summer",
  url: "/assets/cast-summer.glb",
  hipsY: SUMMER_HIPS_Y,
  // Walk bake 2026-11-05: cycle 1.2595 m / 1.1667 s (stance-measured
  // on her own rig during the bake).
  walkSpeed: 1.0796,
  clips: CATALOG,
};

// Ninja (Jim's Ch24 character) was REMOVED from the cast at Jim's
// word on 2026-11-05: her rig shipped with a corrupted bind pose
// (right arm ~2x too long in every clip) and Jim chose deletion over
// repair. Her files are retired to trash, recoverable; the cast is
// Body Block + Summer.

export const BODIES: Record<string, BodyDef> = {
  [BODY_CAST.id]: BODY_CAST,
  [BODY_SUMMER.id]: BODY_SUMMER,
};

/** The body a cast member wears; members name one via `body`, else cast. */
export function bodyForMember(member: { body?: string } | null | undefined): BodyDef {
  return (member?.body && BODIES[member.body]) || BODY_CAST;
}

/**
 * Clip selection for the sit/stand transition: while an embody
 * override is in its mounting phase the figure plays SitDown once,
 * forward; seated it loops SittingTalking; while standing it plays
 * the dedicated StandUp clip forward (the authored sit_to_stand
 * transition — no reverse playback anywhere). No override — no
 * sitting clip at all.
 */
export function sitClipForPhase(
  phase: SitPhase | null | undefined,
): { clip: "sitDown" | "standUp" | "sitTalk" | null } {
  switch (phase) {
    case "mounting":
      return { clip: "sitDown" };
    case "standing":
      return { clip: "standUp" };
    case "seated":
      return { clip: "sitTalk" };
    default:
      return { clip: null };
  }
}
