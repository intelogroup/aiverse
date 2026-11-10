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
  /**
   * Mobile Phase 3: a Lite variant of the same body (animations
   * resampled, accessors quantized — same rig, same clips), loaded
   * instead of `url` while the quality tier is lite. Absent = the
   * body has no variant and always loads `url`.
   */
  liteUrl?: string;
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
  /**
   * Display scale applied to the whole figure (CastFigure), 1 = the GLB as shipped. The registry facts above (hipsY, walkSpeed,
   * run.speed, run.footLift) are ALREADY multiplied by it (bodyAtScale): consumers never scale them again.
   */
  scale?: number;
}

// ---------------------------------------------------------------------------
// Realistic heights (2026-11-07, Jim: "the KayKits are too short, we should not normalize to them"). Every GLB ships at the
// old ~1.3 m cast standard (Body Block's), which is child-sized in the real-size rooms (counter 1.12 m, chair 0.46 m, door knob
// 0.80 m). Rather than re-bake seven GLBs, each body is shown at a display scale and its registry facts are scaled with it:
// lengths and speeds both scale linearly (a longer stride at the same cadence), phase offsets do not. Standing heights were
// measured on the shipped GLBs (IdleLong frame 0, skinned vertices): Body Block 1.340, Summer 1.254 with her hat (head top
// ~1.225), Remy 1.283, Mage 1.306, Barbarian 1.293, Knight 1.293 (all to the hat/helmet tip), Skeleton Warrior 1.30 body +
// horns. Targets (Jim chose "realistic adults"): Remy 1.78, Summer 1.68 (head top), Body Block 1.75, KayKit 1.70 to the tip.
// ---------------------------------------------------------------------------
export const SCALE_CAST = 1.306; // 1.75 / 1.340
export const SCALE_SUMMER = 1.371; // 1.68 / 1.225
export const SCALE_REMY = 1.387; // 1.78 / 1.283
export const SCALE_MAGE = 1.302; // 1.70 / 1.306
export const SCALE_BARBARIAN = 1.315; // 1.70 / 1.293
export const SCALE_KNIGHT = 1.315; // 1.70 / 1.293
export const SCALE_SKELETON_WARRIOR = 1.308; // 1.70 / 1.30 (horns on top)

/** A body shown at `scale`, with its length and speed facts scaled to match (phase offsets are ratios: unchanged). */
export function bodyAtScale(scale: number, raw: BodyDef): BodyDef {
  return {
    ...raw,
    scale,
    hipsY: raw.hipsY * scale,
    walkSpeed: raw.walkSpeed * scale,
    run: raw.run && { speed: raw.run.speed * scale, footLift: raw.run.footLift * scale, phaseOffset: raw.run.phaseOffset },
  };
}

// The resting clip is "IdleLong" (9.9 s, feet planted together). The catalog's 2.7 s "Idle" is NOT a rest pose: its ankles swing
// 0.1-0.6 m apart in a repeating step (a slow walk in place, measured 2026-11-07 on every body, also in the pre-catalog GLBs), so a
// standing bot marched on the spot and the Idle -> Walk crossfade mixed two unrelated step cycles. tests/idle-clip.test.ts pins this.
const CATALOG = { idle: "IdleLong", walk: "Walk", sitTalk: "SittingTalking", sitDown: "SitDown", standUp: "StandUp" };

/** The shared Body Block body every roster member wears by default. */
export const BODY_CAST: BodyDef = bodyAtScale(SCALE_CAST, {
  id: "cast",
  url: "/assets/cast-bodyblock.glb",
  hipsY: CAST_HIPS_Y,
  // Walk bake 2026-11-05: cycle 1.0203 m / 1.1667 s (stance-measured).
  walkSpeed: 0.8746,
  clips: CATALOG,
});

/**
 * Summer — Jim's character (Sitting_small_0_ex78.fbx), a 33-bone
 * Mixamo rig scaled to cast height. Hips measured in Blender from the
 * exported cast-summer.glb at rest.
 */
export const SUMMER_HIPS_Y = 0.7854; // m

export const BODY_SUMMER: BodyDef = bodyAtScale(SCALE_SUMMER, {
  id: "summer",
  url: "/assets/cast-summer.glb",
  liteUrl: "/assets/cast-summer-lite.glb",
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
});

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

export const BODY_MAGE: BodyDef = bodyAtScale(SCALE_MAGE, {
  id: "mage",
  url: "/assets/cast-mage.glb",
  hipsY: MAGE_HIPS_Y,
  // 0.5749 x 0.53391 shrink — see note above.
  walkSpeed: 0.3069,
  clips: CATALOG,
});

export const BARBARIAN_HIPS_Y = 0.2778; // m (0.4601 x 0.60375 shrink)

export const BODY_BARBARIAN: BodyDef = bodyAtScale(SCALE_BARBARIAN, {
  id: "barbarian",
  url: "/assets/cast-barbarian.glb",
  hipsY: BARBARIAN_HIPS_Y,
  // Same Rig_Medium skeleton as the Mage — identical measured Walk
  // foot travel, shrunk by its own factor: 0.5749 x 0.60375.
  walkSpeed: 0.3471,
  clips: CATALOG,
});

export const KNIGHT_HIPS_Y = 0.2702; // m (0.4601 x 0.58713 shrink)

export const BODY_KNIGHT: BodyDef = bodyAtScale(SCALE_KNIGHT, {
  id: "knight",
  url: "/assets/cast-knight.glb",
  hipsY: KNIGHT_HIPS_Y,
  // Same Rig_Medium skeleton — identical measured Walk foot travel,
  // shrunk by its own factor: 0.5749 x 0.58713.
  walkSpeed: 0.3375,
  clips: CATALOG,
});

// ---------------------------------------------------------------------------
// Skeleton Warrior (2026-11-07): KayKit "Character Pack: Skeletons"
// (CC0), same Rig_Medium skeleton as the Adventurers wave, baked with
// the wave's matrix-delta retarget (full 45-clip catalog). Scale rule
// differs from the wave's: uniform scale by TOTAL FIGURE HEIGHT —
// head-mesh top, helmet horns excluded — 2.1661 m x 0.60016 = exactly
// 1.30 m (horn silhouette 1.5547 m). The bone-parented helmet was
// rigid-skinned to the head bone in glTF space before the bake: the
// Blender path misplaces it (measured +0.2006 m unskinned in the
// export, +0.1003 m after an in-Blender conversion — Blender's
// importer itself evaluates bone-parented children high). Bind audit
// of the shipped GLB: all major segments 0.00% off the scaled source,
// helmet bounds exact, weights sum 1.0, soles at Y 0.
// Constants FK-measured on the shipped GLB (stance method, cast
// lineage): stance band min(2 cm, 25% of joint excursion); Walk reads
// the ankle pair (the catalog Walk's toes carry no stance signal on
// any body — BodyBlock's toes measure 0.002 / -0.949 against its
// shipped 0.9165 ankle reading), Run reads all four joints.
// Seated: SitDown end pelvis lands on the 0.45 m bench via hipsY;
// the short legs leave the feet dangling ~0.31 m — a known, accepted
// property of this chibi body.
// ---------------------------------------------------------------------------

export const SKELETON_WARRIOR_HIPS_Y = 0.3116; // m (upperleg joint, bind)

export const BODY_SKELETON_WARRIOR: BodyDef = bodyAtScale(SCALE_SKELETON_WARRIOR, {
  id: "skeleton-warrior",
  url: "/assets/cast-skeleton-warrior.glb",
  hipsY: SKELETON_WARRIOR_HIPS_Y,
  // FK stance: ankle pair 0.3826 / 0.4115 (Walk cycle 1.1667 s).
  walkSpeed: 0.3971,
  // Run stance (4 joints): ankles 0.694 / 0.688, toes 1.236 / 1.239;
  // stance toes sit 0.0084 m above Walk's; ankle touchdown leads
  // 0.153 / 0.170 -> Run leads Walk by 0.1615 of a cycle.
  run: { speed: 0.9642, footLift: 0.0084, phaseOffset: -0.1615 },
  clips: CATALOG,
});

// Remy — Jim's Mixamo character (Remy.fbx, 67 bones), scaled to 1.3 m. Body Block's 45 clips are retargeted
// by bone name (world-space rest-delta bake, tools/city3/bake_remy.py): rest directions sit 6.4 deg mean
// (16.5 max at neck/head) from Body Block's. Hips measured at rest in Blender (0.718 m). Walk/Run measured
// 2026-11-07 on the shipped GLB in three space (headless GLTFLoader + mixer, body translated at v): zero-slip
// speed of the planted toe/ankle joints (within 2 cm of their lowest), swept in 5 mm steps: Walk 0.770 m/s
// (residual 0.001), Run 2.660 m/s (residual 0.002). Same method fails on Body Block's own Walk (plate feet),
// so it is trusted only for anatomical rigs like this one and Summer. Run stance toes sit 0.082 m above Walk's
// (0.142 vs 0.060); touchdowns Walk L 0.3625 / R 0.8833, Run L 0.275 / R 0.8604 -> Run leads by 0.055.
export const REMY_HIPS_Y = 0.718; // m

export const BODY_REMY: BodyDef = bodyAtScale(SCALE_REMY, {
  id: "remy",
  url: "/assets/cast-remy.glb",
  liteUrl: "/assets/cast-remy-lite.glb",
  hipsY: REMY_HIPS_Y,
  walkSpeed: 0.77,
  run: { speed: 2.66, footLift: 0.082, phaseOffset: -0.055 },
  clips: CATALOG,
});

export const BODIES: Record<string, BodyDef> = {
  [BODY_REMY.id]: BODY_REMY,
  [BODY_CAST.id]: BODY_CAST,
  [BODY_SUMMER.id]: BODY_SUMMER,
  [BODY_MAGE.id]: BODY_MAGE,
  [BODY_BARBARIAN.id]: BODY_BARBARIAN,
  [BODY_KNIGHT.id]: BODY_KNIGHT,
  [BODY_SKELETON_WARRIOR.id]: BODY_SKELETON_WARRIOR,
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
