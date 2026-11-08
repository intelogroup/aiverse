// embody.ts — shared figure-layer helpers left from the Embody v0 spike:
// the sit-phase/override types the figure layer renders by, the cast rig's
// measured hips height, the seated-root math, and the heading helper the
// camera rig damps with.
//
// The spike's skill layer itself (EmbodyController + the Agora bench
// anchors) drove only the Agora deck crowd and left with that world
// (2026-11-08, Jim's word — the lobby returns as a planned feature, not
// as this spike). What remains here is the part other modules genuinely
// share: CastFigure and bodies.ts read the sit phases, cameraRig.ts
// imports angleDelta, scout.ts imports Vec2.
//
// Three-free and DOM-free, same discipline as locomotion.ts: positions
// are crowd-space [x, z] pairs and heading follows the locomotion
// convention (heading = atan2(vx, vz); facing vector = (sin h, cos h)).

export type Vec2 = [number, number];

/** A Smart Object anchor: a piece of furniture advertising an interaction. */
export interface Anchor {
  id: string;
  label: string;
  /** Seat position in crowd space; the figure renders here while seated. */
  seat: Vec2;
  /** Heading the seated figure faces, radians. */
  facing: number;
  /** Stand point in front of the seat: the body navigates here, faces
   * the bench, turns its back to it and mounts backwards onto the seat. */
  approach: Vec2;
  /** Seat surface height above the ground plane, m (render lift). */
  seatHeight: number;
  occupiedBy: number | null;
}

/**
 * Which leg of the sit/stand transition an override belongs to. The
 * figure layer plays a different clip per phase (see bodies.ts
 * sitClipForPhase): mounting plays SitDown forward, seated loops
 * SittingTalking, standing plays the dedicated StandUp clip forward.
 */
export type SitPhase = "mounting" | "seated" | "standing";

/** Render transform override for one figure (crowd space + lift). */
export interface FigureOverride {
  position: Vec2;
  /** Height above the ground plane, m. */
  y: number;
  heading: number;
  phase: SitPhase;
}

export const CAST_HIPS_Y = 0.6531; // m — cast rig's standing hips height, measured in Blender from cast-bodyblock.glb

/**
 * Root Y of a figure seated on anchor `a`. The sitting clips carry
 * rotations only (their hips-location channels were stripped at bake
 * time), so the override drops the whole figure by the difference
 * between the rig's standing hips height and the seat top — the pelvis
 * lands on the seat and the bent legs reach the floor (proof-rendered
 * at this exact offset). `hipsY` is the MEMBER's body hips height
 * (bodies.ts registry); it defaults to the cast body's.
 */
export function seatedRootY(a: Anchor, hipsY: number = CAST_HIPS_Y): number {
  return a.seatHeight - hipsY;
}

/** Shortest signed angular distance from `from` to `to`, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
