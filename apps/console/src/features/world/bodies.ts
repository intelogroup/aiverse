// bodies.ts — the per-body registry for cast figures.
//
// A "body" is one rigged GLB plus the facts the console needs to wear
// it: where its hips ride (the embody seat drop is computed from the
// WEARER's hips, not a global constant) and the clip names its catalog
// carries. Every body ships the same five-clip catalog — Idle, Walk,
// SittingTalking, SitDown, StandUp — baked onto its own rig, so skills
// and clip selection never branch per body; only the measurements do.
//
// Three-free and DOM-free, same discipline as embody.ts.

import { CAST_HIPS_Y, type SitPhase } from "./embody";

export interface BodyDef {
  id: string;
  /** GLB under the console's public assets. */
  url: string;
  /** Standing hips height of this rig, m — measured in Blender. */
  hipsY: number;
  clips: { idle: string; walk: string; sitTalk: string; sitDown: string; standUp: string };
}

const CATALOG = { idle: "Idle", walk: "Walk", sitTalk: "SittingTalking", sitDown: "SitDown", standUp: "StandUp" };

/** The shared Body Block body every roster member wears by default. */
export const BODY_CAST: BodyDef = {
  id: "cast",
  url: "/assets/cast-bodyblock.glb",
  hipsY: CAST_HIPS_Y,
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
  clips: CATALOG,
};

/**
 * Ninja — Jim's second character (Sitting__1__small_1_u9zs.fbx,
 * Mixamo Ch24), a 65-bone mixamorig rig scaled to cast height. Hips
 * measured in Blender from the exported cast-ninja.glb at rest.
 */
export const NINJA_HIPS_Y = 0.675; // m

export const BODY_NINJA: BodyDef = {
  id: "ninja",
  url: "/assets/cast-ninja.glb",
  hipsY: NINJA_HIPS_Y,
  clips: CATALOG,
};

export const BODIES: Record<string, BodyDef> = {
  [BODY_CAST.id]: BODY_CAST,
  [BODY_SUMMER.id]: BODY_SUMMER,
  [BODY_NINJA.id]: BODY_NINJA,
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
