// keeper.ts — the Bazaar stall keeper: a cast figure standing before
// his stall who turns to face whoever comes close and talks to them.
//
// This module is the pure half (three-free, DOM-free, same discipline
// as walker.ts / clips.ts): the social trigger state machine plus the
// placement facts. BazaarLife.tsx owns the React/three side — it feeds
// mover positions in each frame, fires the catalog "Talking" clip on
// the enter edge and clears it on the exit edge.
//
// Placement (from tools/city3/out/city3-nav.json + the generator's
// collision boxes in tools/city3/collision.py, verified against the
// shipped collision GLB with the real walker before this was written):
// the keeper keeps stall-0 (centre [-17, 18], the innermost NW stall,
// ~25 m from the plaza fountain where the walk bot spawns). The stall's
// own footprint is solid, so he stands BEFORE it: 1.1 m in front of its
// street face, at [-17, 15.4] on plaza ground (y = 0.2), facing the
// street — heading pi, the lot's own heading (the stall fronts -z,
// toward the fountain). The patrol circuit below stops at the customer
// spot 1.6 m in front of him, inside the trigger radius.

import { angleTo, wrapAngle, WALK_CONFIG, type WalkConfig } from "./walker";

/** A mover this close starts a conversation. */
export const KEEPER_ENTER_RADIUS = 2.2;
/** ...and it ends only once every mover is farther than this (hysteresis, so the boundary never flickers). */
export const KEEPER_EXIT_RADIUS = 3.0;
/** How fast the keeper may turn, rad/s — feet planted, a social turn, not a spin. */
export const KEEPER_TURN_RATE = 2.4;

/** The lot the keeper keeps (city3-nav.json). */
export const KEEPER_LOT_ID = "stall-0";
/** Where the keeper stands [x, z]: before stall-0, on the street side. */
export const KEEPER_POS: [number, number] = [-17, 15.4];
/** His resting facing: the lot's heading, out toward the plaza. */
export const KEEPER_HOME_HEADING = Math.PI;

export interface KeeperState {
  talking: boolean;
  /** Current facing (radians, walker convention: faces (sin h, cos h)). */
  heading: number;
  homeHeading: number;
}

export function createKeeper(homeHeading: number): KeeperState {
  return { talking: false, heading: homeHeading, homeHeading };
}

export interface KeeperEvents {
  /** talking flipped false -> true this step (fire the clip). */
  entered: boolean;
  /** talking flipped true -> false this step (clear the clip). */
  exited: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Advance the trigger one frame. `movers` are the [x, z] positions of
 * every character who could start a conversation (the walk bot, the
 * patrol). The nearest mover inside the zone owns the keeper's facing.
 * Mutates and returns events for the clip side effects.
 */
export function stepKeeper(
  k: KeeperState,
  dt: number,
  self: [number, number],
  movers: readonly [number, number][],
): KeeperEvents {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const m of movers) {
    const d = Math.hypot(m[0] - self[0], m[1] - self[1]);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }

  let entered = false;
  let exited = false;
  if (!k.talking && best !== null && bestD <= KEEPER_ENTER_RADIUS) {
    k.talking = true;
    entered = true;
  } else if (k.talking && (best === null || bestD > KEEPER_EXIT_RADIUS)) {
    k.talking = false;
    exited = true;
  }

  const target =
    k.talking && best !== null
      ? Math.atan2(best[0] - self[0], best[1] - self[1])
      : k.homeHeading;
  const turn = clamp(angleTo(k.heading, target), -KEEPER_TURN_RATE * dt, KEEPER_TURN_RATE * dt);
  k.heading = wrapAngle(k.heading + turn);
  return { entered, exited };
}

// ---------------------------------------------------------------------------
// The patrol: a second cast figure walking a circuit of stall fronts so
// the keeper has someone to talk to even when nobody is driving the
// bot. Stand points sit ~1.6 m in front of each stall's street face
// (the same customer spot a player would take); `face` is the heading
// held while dwelling there (toward the stall). The first stop is the
// keeper's own stall with the long dwell — that pause, inside the
// trigger radius, is what starts keeper conversations on its own.
// ---------------------------------------------------------------------------

export interface PatrolStop {
  pos: [number, number];
  /** Heading held while dwelling (toward the stall). */
  face: number;
  /** Seconds to linger before walking on. */
  dwell: number;
}

export const PATROL_STOPS: PatrolStop[] = [
  { pos: [-17, 13.8], face: 0, dwell: 6 }, // stall-0 — the keeper's stall
  { pos: [17, 13.8], face: 0, dwell: 2 }, // stall-40
  { pos: [17, -14.9], face: Math.PI, dwell: 2 }, // stall-60
  { pos: [-17, -14.9], face: Math.PI, dwell: 2 }, // stall-20
];

/** The patrol's cruise, m/s (its Walk cycle is driven through the gait path, like the bot's). */
export const PATROL_CRUISE = 1.0;

export const PATROL_CONFIG: WalkConfig = { ...WALK_CONFIG, walkSpeed: PATROL_CRUISE };
