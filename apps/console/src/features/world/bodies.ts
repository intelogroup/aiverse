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
  /**
   * Run-cycle facts for gait-driven frames (AgentFrame.gait, the City 3 walker): natural ground speed of the
   * catalog "Run" clip (in-place, so measured from the stance feet), how far its stance foot rides above Walk's
   * (the bake stripped the hips drop, so the figure is lowered by this x run weight), and the Run-minus-Walk
   * touchdown phase offset used to keep the two clips in step while they crossfade. Absent = the body never runs.
   */
  run?: { speed: number; footLift: number; phaseOffset: number };
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
  // Walk re-measured 2026-11-07 on the corrected fixed GLB (PR #27):
  // stance speed 1.107 m/s over the 1.1667 s cycle (1.2915 m).
  walkSpeed: 1.107,
  // Run re-measured 2026-11-07 on the same corrected fixed GLB (PR #27 commit 2, sha256 f6590037…) by FK
  // replication of the console figure math (root-motion cancel + vertical guard as CastFigure applies):
  // stance = toe and ankle joints while within 2 cm of their lowest point. The replication reproduces the
  // prior registry's corrupt-body numbers within 0.3–0.9% (Walk 1.0847, Run 2.6485, footLift 0.0908).
  // On the fixed body: Run 2.7755 m/s, so the 0.7333 s cycle covers a 2.035 m stride. Run's stance toes
  // sit 0.0967 m above Walk's (stance-mean basis; hips track constant in both clips: no bob, no ramp,
  // no XZ travel). Touchdown lead: L 0.102 / R 0.064 (cycle phase) -> Run leads by 0.083.
  run: { speed: 2.7755, footLift: 0.0967, phaseOffset: -0.083 },
  clips: CATALOG,
};

// Ninja (Jim's Ch24 character) was REMOVED from the cast at Jim's
// word on 2026-11-05: her rig shipped with a corrupted bind pose
// (right arm ~2x too long in every clip) and Jim chose deletion over
// repair. Her files are retired to trash, recoverable; the cast is
// Body Block + Summer.

// ---------------------------------------------------------------------------
// Character wave (2026-11-05): KayKit "Character Pack: Adventurers"
// (CC0) bodies, Rig_Medium skeletons retargeted with the full 45-clip
// catalog. KayKit proportions are chibi — short legs, a head that is
// half the figure, tall headgear — so the wave's first scaling rule
// (head joint pinned to 1.10 m, like the cast's 1.0956) left the
// TOTALS at 2.15–2.45 m next to the cast's ~1.3 m, and Jim called it:
// "why are the mage and barbarian so big". Rescaled the same evening
// at his word ("Shrink all three to match the others (~1.3 m)"): each
// GLB uniformly scaled so its total height is exactly 1.30 m — Mage
// x0.53391 (was 2.4349 m at rest), Barbarian x0.60375 (2.1532 m),
// Knight x0.58713 (2.2142 m) — and the registry facts below scaled by
// the same factor. The bone-parented attachments (hat, helmet, cape,
// shield) were first converted to rigid skinning on their bone: the
// exporter's bone-parent path mis-scales them ~10%, which had the
// rescaled figures still standing 1.42 m at the hat tip.
// Hips Y is the measured pelvis (upperleg) joint height of the
// exported GLB — the seat drop uses it exactly like the other bodies.
// Walk speed: the cast Walk joint motion retargeted verbatim, so the
// natural speed scales with the stride the rig performs — originally
// cast walkSpeed x (this body's Walk foot fore-aft travel / cast's),
// both measured on the shipped GLBs (cast avg 0.4466 m), then x the
// shrink factor above.
// ---------------------------------------------------------------------------

export const MAGE_HIPS_Y = 0.2457; // m (0.4601 x 0.53391 shrink)

export const BODY_MAGE: BodyDef = {
  id: "mage",
  url: "/assets/cast-mage.glb",
  hipsY: MAGE_HIPS_Y,
  // 0.5749 x 0.53391 shrink — see note above.
  walkSpeed: 0.3069,
  clips: CATALOG,
};

export const BARBARIAN_HIPS_Y = 0.2778; // m (0.4601 x 0.60375 shrink)

export const BODY_BARBARIAN: BodyDef = {
  id: "barbarian",
  url: "/assets/cast-barbarian.glb",
  hipsY: BARBARIAN_HIPS_Y,
  // Same Rig_Medium skeleton as the Mage — identical measured Walk
  // foot travel, shrunk by its own factor: 0.5749 x 0.60375.
  walkSpeed: 0.3471,
  clips: CATALOG,
};

export const KNIGHT_HIPS_Y = 0.2702; // m (0.4601 x 0.58713 shrink)

export const BODY_KNIGHT: BodyDef = {
  id: "knight",
  url: "/assets/cast-knight.glb",
  hipsY: KNIGHT_HIPS_Y,
  // Same Rig_Medium skeleton — identical measured Walk foot travel,
  // shrunk by its own factor: 0.5749 x 0.58713.
  walkSpeed: 0.3375,
  clips: CATALOG,
};

export const BODIES: Record<string, BodyDef> = {
  [BODY_CAST.id]: BODY_CAST,
  [BODY_SUMMER.id]: BODY_SUMMER,
  [BODY_MAGE.id]: BODY_MAGE,
  [BODY_BARBARIAN.id]: BODY_BARBARIAN,
  [BODY_KNIGHT.id]: BODY_KNIGHT,
};

/** The body a cast member wears; members name one via `body`, else cast. */
export function bodyForMember(member: { body?: string } | null | undefined): BodyDef {
  return (member?.body && BODIES[member.body]) || BODY_CAST;
}

/**
 * A roster with one body removed: every member wearing it goes,
 * including members who wear it by default (no `body` named, or a
 * name the registry does not know). Used to retire a body from one
 * world without touching the others.
 */
export function excludeBody<T extends { body?: string }>(
  members: readonly T[],
  excluded: BodyDef,
): T[] {
  return members.filter((member) => bodyForMember(member) !== excluded);
}

/**
 * Fastest ground speed a body may cruise: its measured walkSpeed plus a
 * small stride headroom. Past it the walk cycle visibly skates, so the
 * crowd caps each slot at its wearer's value (locomotion's
 * maxSpeedForIndex) instead of one slot-blind pace band for all bodies.
 */
export function cruiseCapForBody(body: BodyDef): number {
  return body.walkSpeed * 1.15;
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
