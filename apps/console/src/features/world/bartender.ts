// bartender.ts — the Tea House bartender: stands behind the bar, turns to whoever comes up to it and greets them out loud.
//
// The pure half (three-free, DOM-free, like keeper.ts). TeaBartender.tsx owns the figure, the speech and the collider.
// Placement (from the shipped tea.json / tea.col.json, 2026-11-07): the bar is six 2 m counters on z = -81.35 (box
// half-depth 0.57: back face z = -81.92), the bottle shelves stand at z = -83.82 (half-depth 0.37: front face z = -83.45). He
// stands in the middle of that 1.53 m corridor, at the middle of the 12 m bar run, facing the stools (+z, heading 0).
import { KEEPER_TURN_RATE } from "./keeper";
import { angleTo, wrapAngle } from "./walker";

export const BARTENDER_POS: [number, number] = [-29.5, -82.69];
export const BARTENDER_HOME_HEADING = 0;
/** The Tea House floor (the walker stands at the plinth top, 0.48). */
export const BARTENDER_FLOOR_Y = 0.48;
/**
 * Who counts as "at the bar". The bar is 12 m long and customers stand >= 0.4 m in front of the stools (z <= -79.74), i.e.
 * ~3 m from him at best: a circle round one man would cover ~2.5 m of the bar front. So the trigger is the ZONE in front of the
 * whole counter run (x -35.55..-23.45, 3 m deep from the stools) OR being near him; leaving needs the zone grown by 1 m
 * (hysteresis, so standing on the edge never flickers).
 */
export const BARTENDER_ENTER_RADIUS = 3.2;
export const BARTENDER_EXIT_RADIUS = 4.2;
/** [minX, minZ, maxX, maxZ] in front of the bar. */
export const BAR_FRONT_ZONE: readonly [number, number, number, number] = [-35.6, -80.3, -23.4, -77.3];
export const BAR_FRONT_EXIT_GROW = 1.0;
/** The same visitor is not greeted again within this many seconds (no chatter loop at the bar). */
export const BARTENDER_REGREET_S = 45;
/**
 * Duckboard under him: 0 since the cast is shown at realistic heights (bodies.ts; Remy 1.78 m clears the 1.12 m counter from the
 * chest up). It was 0.35 m while the cast stood ~1.3 m tall and only his head showed. Kept as a knob for other bars.
 */
export const BARTENDER_PLATFORM_H = 0;
/** His collider footprint half-extents (x, z) (body, or body + board when there is one). */
export const BARTENDER_PLATFORM_HALF: [number, number] = [0.3, 0.3];
/** His body + the board as one walker collider [cx, cz, hx, hz, y0, y1, rotY]: nobody walks through him or steps onto the board. */
export const BARTENDER_COLLIDER: [number, number, number, number, number, number, number] = [
  BARTENDER_POS[0], BARTENDER_POS[1], BARTENDER_PLATFORM_HALF[0], BARTENDER_PLATFORM_HALF[1],
  BARTENDER_FLOOR_Y, BARTENDER_FLOOR_Y + BARTENDER_PLATFORM_H + 1.6, 0,
];

export interface BartenderLine {
  /** Pre-rendered fallback clip key: /assets/tts/lines/<id>.mp3 */
  id: string;
  text: string;
}

/** First visit, then a returning visitor. Pre-synthesized at warm-up and pre-rendered as clips, so he never speaks late. */
export const BARTENDER_LINES: readonly BartenderLine[] = [
  { id: "bartender1", text: "Welcome to the Matchmaker's Tea House. What can I pour for you?" },
  { id: "bartender2", text: "Back again? The kettle's still warm. Take any seat you like." },
];

export interface BartenderStep {
  /** A greeting starts this step: the line to say. */
  greet: BartenderLine | null;
}

function inRect(p: readonly [number, number], r: readonly [number, number, number, number], grow = 0): boolean {
  return p[0] >= r[0] - grow && p[0] <= r[2] + grow && p[1] >= r[1] - grow && p[1] <= r[3] + grow;
}
const distTo = (p: readonly [number, number]) => Math.hypot(p[0] - BARTENDER_POS[0], p[1] - BARTENDER_POS[1]);
/** Someone who should be greeted now. */
export function atBar(p: readonly [number, number]): boolean {
  return inRect(p, BAR_FRONT_ZONE) || distTo(p) <= BARTENDER_ENTER_RADIUS;
}
/** Someone who still holds his attention (the grown zone). */
export function nearBar(p: readonly [number, number]): boolean {
  return inRect(p, BAR_FRONT_ZONE, BAR_FRONT_EXIT_GROW) || distTo(p) <= BARTENDER_EXIT_RADIUS;
}

/** Greeting trigger + facing. `movers` are visitor positions (the player, Scout, ...). */
export class BartenderGreeter {
  heading = BARTENDER_HOME_HEADING;
  engaged = false;
  private now = 0;
  private lastGreetAt = -Infinity;
  private greetings = 0;

  step(dt: number, movers: readonly [number, number][]): BartenderStep {
    this.now += dt;
    let entered = false;
    if (!this.engaged && movers.some(atBar)) {
      this.engaged = true;
      entered = true;
    } else if (this.engaged && !movers.some(nearBar)) {
      this.engaged = false;
    }
    // Face the nearest visitor who holds his attention; home (the room) otherwise. Feet planted: a social turn, not a spin.
    let target = BARTENDER_HOME_HEADING;
    if (this.engaged) {
      let best: readonly [number, number] | null = null;
      for (const m of movers) if (nearBar(m) && (!best || distTo(m) < distTo(best))) best = m;
      if (best) target = Math.atan2(best[0] - BARTENDER_POS[0], best[1] - BARTENDER_POS[1]);
    }
    const turn = Math.max(-KEEPER_TURN_RATE * dt, Math.min(KEEPER_TURN_RATE * dt, angleTo(this.heading, target)));
    this.heading = wrapAngle(this.heading + turn);
    if (!entered || this.now - this.lastGreetAt < BARTENDER_REGREET_S) return { greet: null };
    this.lastGreetAt = this.now;
    const line = BARTENDER_LINES[Math.min(this.greetings, BARTENDER_LINES.length - 1)];
    this.greetings += 1;
    return { greet: line };
  }
}

/** Seconds to turn round fully (sanity for tests/docs): pi / turn rate. */
export const BARTENDER_FULL_TURN_S = Math.PI / KEEPER_TURN_RATE;
