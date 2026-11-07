/**
 * Sound v1 — pure audio logic, no WebAudio and no three.js here so it
 * is unit-testable (same discipline as districts.ts / teaDoor.ts). The
 * stateful WebAudio engine lives in soundDirector.ts and consumes
 * these functions; every number the headless proofs assert traces to
 * a function in this file.
 *
 * The five v1 pieces (Jim's slice, 2026-11-07 — start small):
 *  1. Central PA: one announcer voice, district-scoped announcements
 *     (paAudible / districtAt), pre-rendered Phonon clips for the
 *     fixed clock lines, a banner, and a procedural chime otherwise.
 *  2. Tea House door creak + latch, driven by the door's leaf angle
 *     (creakFor) — the #33 choreography clock, sampled.
 *  3. Footsteps from FootLock plant events, gain by distance
 *     (distanceGain) within STEP_AUDIBLE_M.
 *  4. A procedural wind bed, Bazaar-scoped (districtAt again).
 *  5. Tea House zone music with a threshold crossfade (stepFade) and
 *     the priority rule: PA ducks music + wind (duckedGain).
 *
 * The verse clock: the console has NO time-of-day system — district
 * themes are spatial constants (the Bazaar sits at permanent dusk,
 * theme night 0.7). So the PA clock is an audio-layer verse-day
 * timer (VERSE_DAY_S), starting mid-morning; dawn/dusk announcements
 * fire when it crosses its boundaries. Syncing to a future visual
 * day cycle is v2.
 *
 * Follow-on (Jim, 2026-11-07, same day): the Mage's stall music
 * emitter (emitterGain / MAGE_STALL_POS) — positional loudness from
 * a point source, riding the music layer's ducking + mute rules
 * exactly like the tea zone music does.
 */

import { rectDistance, type DistrictDef } from "./districts";

/** A district definition reduced to what scope matching needs. */
export type DistrictLite = Pick<DistrictDef, "id" | "center" | "half">;

/**
 * The district whose square contains (x, z), or null in the water
 * between islands. District squares never overlap (centres 400 m
 * apart, half 180), so at most one contains the point.
 */
export function districtAt(
  x: number,
  z: number,
  defs: readonly DistrictLite[],
): string | null {
  for (const d of defs) {
    if (rectDistance(x, z, d as DistrictDef) === 0) return d.id;
  }
  return null;
}

/** PA scope: a district id, or "verse" for everywhere. */
export type PaScope = string;
export const PA_VERSE_SCOPE = "verse";

/**
 * Whether a listener standing in `listenerDistrict` hears an
 * announcement scoped `scope`. Verse-wide always lands; a district
 * scope lands only inside that district (null — open water — hears
 * nothing district-scoped).
 */
export function paAudible(
  listenerDistrict: string | null,
  scope: PaScope,
): boolean {
  if (scope === PA_VERSE_SCOPE) return true;
  return listenerDistrict === scope;
}

/**
 * Distance falloff for point sounds (footsteps, the tea door):
 * full gain at the listener, squared falloff to silence at `far`.
 */
export function distanceGain(distance: number, far: number): number {
  if (distance >= far) return 0;
  if (distance <= 0) return 1;
  const t = 1 - distance / far;
  return t * t;
}

/** Footsteps are audible within this radius of the listener (m). */
export const STEP_AUDIBLE_M = 12;
/** The tea door's sounds carry this far (m). */
export const DOOR_AUDIBLE_M = 20;

/**
 * The Bazaar keeper's stand point (PR #32: the Mage before stall-0).
 * Jim's positional music emitter lives here — a point source, the
 * third placement shape beside the tea room rect and district scope.
 */
export const MAGE_STALL_POS = { x: -17, z: 15.4 } as const;
/** Inside this distance the emitter is simply THERE: full gain (m). */
export const EMITTER_FULL_M = 2.5;
/** The emitter falls to silence at this distance (m). */
export const EMITTER_AUDIBLE_M = 16;

/**
 * Emitter loudness by distance: full inside the core radius, then
 * the same squared falloff as distanceGain across the remaining
 * span to silence. Non-finite distances are silent (the director's
 * poisoned-input rule). This is the curve PR #35 proved in-browser
 * for the Mage's stall music; the plaza voice emitter reuses it so
 * speech and music share one positional law.
 */
export function emitterGain(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  if (distance <= EMITTER_FULL_M) return 1;
  if (distance >= EMITTER_AUDIBLE_M) return 0;
  const t =
    1 - (distance - EMITTER_FULL_M) / (EMITTER_AUDIBLE_M - EMITTER_FULL_M);
  return t * t;
}

/** While a PA announcement plays, music + wind dip to this share. */
export const DUCK_FACTOR = 0.22;
/** A layer's effective gain under the v1 priority rule. */
export function duckedGain(base: number, paActive: boolean): number {
  return paActive ? base * DUCK_FACTOR : base;
}

/**
 * One step of a linear crossfade: move `current` toward `target` by
 * at most dt/fadeS of the full swing. fadeS <= 0 snaps.
 */
export function stepFade(
  current: number,
  target: number,
  dt: number,
  fadeS: number,
): number {
  if (fadeS <= 0) return target;
  const step = dt / fadeS;
  if (current < target) return Math.min(target, current + step);
  if (current > target) return Math.max(target, current - step);
  return current;
}

/** Nominal layer levels (before ducking / master). */
export const WIND_GAIN = 0.055;
export const MUSIC_GAIN = 0.17;
export const PA_GAIN = 0.9;
/** Nominal level of a bot's spoken line at the voice emitter (before positional gain). */
export const VOICE_GAIN = 0.9;

/** One verse day on the PA clock (s). Dawn at 0, dusk at half. */
export const VERSE_DAY_S = 600;
/** The clock starts here (mid-morning) so neither announcement is
 * immediate on entering walk mode; dusk follows ~150 s later. */
export const VERSE_CLOCK_START_S = 150;

export type VerseClockEvent = "dawn" | "dusk";

/**
 * Clock events whose boundaries fall in (prev, now] on the verse
 * clock: dawn at every k*VERSE_DAY_S, dusk at k*VERSE_DAY_S + half.
 * Handles multi-boundary jumps (a long stall fires each once, in
 * order) and never refires a boundary already reported.
 */
export function clockEventsBetween(prev: number, now: number): VerseClockEvent[] {
  const out: VerseClockEvent[] = [];
  if (now <= prev) return out;
  const half = VERSE_DAY_S / 2;
  const firstCycle = Math.floor(prev / VERSE_DAY_S);
  const lastCycle = Math.floor(now / VERSE_DAY_S);
  for (let k = firstCycle; k <= lastCycle; k++) {
    const dawnAt = k * VERSE_DAY_S;
    const duskAt = dawnAt + half;
    if (dawnAt > prev && dawnAt <= now) out.push("dawn");
    if (duskAt > prev && duskAt <= now) out.push("dusk");
  }
  return out;
}

/**
 * Door creak drive from the leaf angle: while the leaf is moving
 * through its swing, the creak's gain follows the angular speed and
 * its playback rate rises with the angle (a hinge under load sings
 * higher as it opens). Stationary or parked leaves are silent.
 */
export function creakFor(
  angleDeg: number,
  prevAngleDeg: number,
  dt: number,
): { gain: number; rate: number } {
  if (dt <= 0) return { gain: 0, rate: 1 };
  const speed = Math.abs(angleDeg - prevAngleDeg) / dt; // deg/s
  if (speed < 2 || angleDeg <= 0 || angleDeg >= 95) return { gain: 0, rate: 1 };
  const gain = Math.min(1, speed / 130) * 0.55;
  const rate = 0.75 + (angleDeg / 95) * 0.5;
  return { gain, rate };
}

/** A live announcement, as the banner + engine track it. */
export interface Announcement {
  id: number;
  text: string;
  scope: PaScope;
  /** Pre-rendered clip key ("pa-dawn" …) or null for chime-only. */
  clip: string | null;
  /** Director-clock start (s). */
  startAt: number;
  /** How long the audio runs (s): the clip, or the chime's 0.5 s. */
  audioDur: number;
}

/** The banner lingers this long after the audio ends (s). */
export const BANNER_LINGER_S = 1.6;

/**
 * Whether the PA banner for `a` should be on screen at `now` for a
 * listener in `listenerDistrict`: only while the announcement is
 * fresh (audio + linger) and audible from where they stand.
 */
export function bannerVisible(
  a: Announcement | null,
  now: number,
  listenerDistrict: string | null,
): boolean {
  if (!a) return false;
  if (!paAudible(listenerDistrict, a.scope)) return false;
  return now < a.startAt + a.audioDur + BANNER_LINGER_S;
}

/** The fixed clock announcements (text matches the rendered clips). */
export const PA_LINES = {
  dawn: {
    text: "Good morning. Dawn breaks over the Sunstone Bazaar.",
    clip: "pa-dawn",
    scope: "bazaar",
  },
  dusk: {
    text: "Dusk falls on the Sunstone Bazaar. The lamps are lit.",
    clip: "pa-dusk",
    scope: "bazaar",
  },
  tea: {
    text: "The Matchmaker's Tea House is now open.",
    clip: "pa-tea",
    scope: "bazaar",
  },
} as const;
