// walker.ts — kinematic walker for worlds with no crowd/navmesh (City 3).
//
// Pure and three-free (same discipline as cameraRig.ts / bodyController.ts): `step(state, input, dt, world)`
// advances one body by one frame. The terrain is reached ONLY through the `World` interface, so the same code
// runs against a BVH raycast world in the console (bvhWorld.ts), and against fake worlds in unit tests.
//
// The input is an abstract INTENT, not a keyboard: {forward, strafe, turn, run} (+ optional `look` radians and
// `faceHeading`). The keyboard/mouse adapter lives in CityWalker.tsx; an agent will later drive the same
// function with intents of its own (see `moveToIntent`).
//
// Conventions (cameraRig / locomotion): heading h faces (sin h, cos h) in (x, z); y is up.
// With that facing, the body's right-hand side is (-cos h, sin h). Turning RIGHT therefore DECREASES h.

export type Vec2 = [number, number];

export interface WalkerState {
  x: number;
  /** Feet height (world y). */
  y: number;
  z: number;
  /** VIEW heading (see conventions above): camera and movement frame. */
  heading: number;
  /**
   * BODY heading: what the figure faces. Third-person standard: it turns toward the direction of travel at
   * cfg.bodyTurnRate (strafing turns the body sideways), except a walking backpedal, where it faces away from the
   * travel direction and `backward` is set (the figure plays Walk in reverse). Standing still it faces the view.
   */
  body: number;
  backward: boolean;
  /** Horizontal velocity, m/s. */
  vx: number;
  vz: number;
  /** Horizontal speed, m/s (|v|) — what picks the walk/idle clip. */
  speed: number;
  /** Vertical speed while falling off a ledge, m/s (<= 0). */
  vy: number;
  grounded: boolean;
}

export interface WalkInput {
  /** -1..1, +1 = ahead along the heading. */
  forward: number;
  /** -1..1, +1 = to the right. */
  strafe: number;
  /** -1..1 turn rate, +1 = turn right (clockwise seen from above) at cfg.turnRate. */
  turn: number;
  run: boolean;
  /** Extra yaw this frame in radians, +ve = right (mouse-look). */
  look?: number;
  /** Agent intent: turn toward this heading at cfg.turnRate (overrides `turn`/`look` when set). */
  faceHeading?: number;
}

export interface Hit {
  /** Unit horizontal normal of the obstruction, pointing AWAY from it (toward the walker). */
  nx: number;
  nz: number;
  /** Penetration depth in metres (>= 0) when the capsule would overlap the obstruction after the move. */
  depth: number;
}

export interface World {
  prepareStep?(state: WalkerState): void;
  finishStep?(state: WalkerState): void;
  /**
   * Height of the walkable surface under (x, z): the highest surface at or below `fromY` (so decks above the
   * walker — bridges, roofs — are ignored), or null where there is nothing (void, open water).
   */
  groundY(x: number, z: number, fromY: number): number | null;
  /**
   * Would a body of `radius` standing at `to` (feet at to.y) be inside a wall, having come from `from`?
   * Casts at body height, above the step-up. Returns the obstruction (null = free).
   */
  blocked(from: Vec3, to: Vec3, radius: number): Hit | null;
  /** True when a straight sight line from `from` to `to` (eye points) meets collision geometry. Absent: nothing blocks sight. */
  sightBlocked?(from: Vec3, to: Vec3): boolean;
}

export type Vec3 = [number, number, number];

export interface WalkConfig {
  walkSpeed: number;
  runSpeed: number;
  /** 1/s: how quickly velocity follows the wanted velocity. */
  accel: number;
  turnRate: number;
  radius: number;
  /** Highest riser the walker steps up without jumping. */
  stepUp: number;
  /** Ground below this is water: never entered. */
  waterY: number;
  gravity: number;
  /** A drop this small is walked down instantly (stairs down, curbs). */
  stepDown: number;
  /** rad/s: how fast the BODY heading chases the travel direction. */
  bodyTurnRate: number;
  /** Travel this far (rad) from the view heading, walking, is a backpedal; back below `backExit` it is not. */
  backEnter: number;
  backExit: number;
}

export const WALK_CONFIG: WalkConfig = {
  walkSpeed: 1.3,
  // 3.6 since the cast was shown at realistic heights (bodies.ts): a 1.68 m Summer's natural Run is 3.8 m/s, and 2.7 sat
  // mid-blend (half walk, half run). 3.6 is a realistic adult run and plays her Run at 0.95x.
  runSpeed: 3.6,
  accel: 14,
  turnRate: 2.2,
  radius: 0.4,
  stepUp: 0.4,
  waterY: -0.5,
  gravity: 14,
  stepDown: 0.4,
  bodyTurnRate: 10,
  backEnter: (120 * Math.PI) / 180,
  backExit: (100 * Math.PI) / 180,
};

/** Speed below which the body counts as standing (clip choice). */
export const MOVING_SPEED = 0.15;

export function makeWalker(x: number, y: number, z: number, heading = 0): WalkerState {
  return { x, y, z, heading, body: heading, backward: false, vx: 0, vz: 0, speed: 0, vy: 0, grounded: true };
}

export function wrapAngle(a: number): number {
  let n = a % (Math.PI * 2);
  if (n > Math.PI) n -= Math.PI * 2;
  if (n <= -Math.PI) n += Math.PI * 2;
  return n;
}

/** Shortest signed turn from `a` to `b`. */
export function angleTo(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Speed above which the gait reads "run" (between walkSpeed 1.3 and runSpeed 2.7; the clip blend itself is gait.ts). */
export const RUNNING_SPEED = 1.6;

/** Locomotion state from speed: what CastFigure's AgentFrame.state carries. */
export function clipFor(speed: number): "walk" | "run" | "idle" {
  return speed > RUNNING_SPEED ? "run" : speed > MOVING_SPEED ? "walk" : "idle";
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Advance the BODY heading one frame (pure; `step` calls it). `wish` is the wanted travel direction in (x, z)
 * (null when no movement is asked for). Moving: face the travel direction, or, walking with travel more than
 * cfg.backEnter from the view (hysteresis down to cfg.backExit), face AWAY from it and backpedal. Running never
 * backpedals: the body turns round and runs. Standing: face the view heading.
 */
export function stepBody(
  s: Pick<WalkerState, "heading" | "body" | "backward">,
  wish: Vec2 | null,
  run: boolean,
  dt: number,
  cfg: WalkConfig = WALK_CONFIG,
): void {
  let target = s.heading;
  if (wish && Math.hypot(wish[0], wish[1]) > 1e-6) {
    const dir = Math.atan2(wish[0], wish[1]);
    const off = Math.abs(angleTo(s.heading, dir));
    s.backward = !run && off > (s.backward ? cfg.backExit : cfg.backEnter);
    target = s.backward ? wrapAngle(dir + Math.PI) : dir;
  } else {
    s.backward = false;
  }
  const d = angleTo(s.body, target);
  const m = cfg.bodyTurnRate * dt;
  s.body = wrapAngle(s.body + clamp(d, -m, m));
}

/**
 * Try the horizontal move (dx, dz) from the current position. Walls: the part of the move into an obstruction is
 * removed (slide along it); a second pass handles corners. Returns the accepted displacement.
 */
function slide(s: WalkerState, dx: number, dz: number, world: World, cfg: WalkConfig): Vec2 {
  let mx = dx;
  let mz = dz;
  for (let pass = 0; pass < 3; pass++) {
    if (mx * mx + mz * mz < 1e-12) return [0, 0];
    const hit = world.blocked([s.x, s.y, s.z], [s.x + mx, s.y, s.z + mz], cfg.radius);
    if (!hit) return [mx, mz];
    const into = mx * hit.nx + mz * hit.nz;
    if (into >= 0) {
      // Moving away from (or along) the obstruction: allowed, but push out of any overlap.
      return [mx + hit.nx * hit.depth, mz + hit.nz * hit.depth];
    }
    mx -= hit.nx * into;
    mz -= hit.nz * into;
  }
  return [0, 0];
}

/** Ground check for a candidate (x, z): the new feet height, or null if the spot is not walkable. */
function walkableY(s: WalkerState, x: number, z: number, world: World, cfg: WalkConfig): number | null {
  const gy = world.groundY(x, z, s.y + cfg.stepUp + 0.05);
  if (gy === null || gy < cfg.waterY) return null;
  if (gy - s.y > cfg.stepUp) return null; // a wall of a step, not a stair
  return gy;
}

/**
 * Advance the walker one frame. Mutates and returns `s` (callers keep one state object per body).
 */
export function step(s: WalkerState, input: WalkInput, dt: number, world: World, cfg: WalkConfig = WALK_CONFIG): WalkerState {
  dt = clamp(dt, 0, 0.1);
  if (dt === 0) return s;
  world.prepareStep?.(s);

  // ---- heading ----
  if (input.faceHeading !== undefined) {
    const d = angleTo(s.heading, input.faceHeading);
    const m = cfg.turnRate * dt;
    s.heading = wrapAngle(s.heading + clamp(d, -m, m));
  } else {
    s.heading = wrapAngle(s.heading - input.turn * cfg.turnRate * dt - (input.look ?? 0));
  }

  // ---- wanted velocity (view-relative) ----
  const f = clamp(input.forward, -1, 1);
  const r = clamp(input.strafe, -1, 1);
  const mag = Math.hypot(f, r);
  const top = input.run ? cfg.runSpeed : cfg.walkSpeed;
  const sn = Math.sin(s.heading);
  const cs = Math.cos(s.heading);
  let wx = 0;
  let wz = 0;
  if (mag > 1e-6) {
    const k = (top * Math.min(1, mag)) / mag;
    wx = (sn * f - cs * r) * k; // forward (sin,cos) + right (-cos,sin)
    wz = (cs * f + sn * r) * k;
  }
  stepBody(s, mag > 1e-6 ? [wx, wz] : null, input.run, dt, cfg);
  const a = 1 - Math.exp(-cfg.accel * dt);
  s.vx += (wx - s.vx) * a;
  s.vz += (wz - s.vz) * a;
  if (mag <= 1e-6 && Math.hypot(s.vx, s.vz) < 0.05) { s.vx = 0; s.vz = 0; }

  // ---- horizontal move: walls, then ground ----
  let [mx, mz] = slide(s, s.vx * dt, s.vz * dt, world, cfg);
  let gy = walkableY(s, s.x + mx, s.z + mz, world, cfg);
  if (gy === null && (mx !== 0 || mz !== 0)) {
    // Ledge / water / void ahead: slide along it by trying each axis alone.
    const gx = mx !== 0 ? walkableY(s, s.x + mx, s.z, world, cfg) : null;
    const gz = mz !== 0 ? walkableY(s, s.x, s.z + mz, world, cfg) : null;
    if (gx !== null) { mz = 0; gy = gx; }
    else if (gz !== null) { mx = 0; gy = gz; }
    else { mx = 0; mz = 0; gy = world.groundY(s.x, s.z, s.y + cfg.stepUp + 0.05); }
  }
  s.x += mx;
  s.z += mz;
  // The velocity we actually achieved (so speed -> clip stays honest against walls).
  const ax = mx / dt;
  const az = mz / dt;
  s.vx = Math.abs(ax) < Math.abs(s.vx) ? ax : s.vx;
  s.vz = Math.abs(az) < Math.abs(s.vz) ? az : s.vz;
  s.speed = Math.hypot(ax, az);

  // ---- vertical: step up instantly, small drops snap, big drops fall ----
  if (gy === null) {
    s.grounded = false; // nothing under us (should not normally happen): hold height
  } else if (gy >= s.y) {
    s.y = gy; s.vy = 0; s.grounded = true;
  } else if (s.y - gy <= cfg.stepDown && s.grounded) {
    s.y = gy; s.vy = 0;
  } else {
    s.grounded = false;
    s.vy -= cfg.gravity * dt;
    s.y = Math.max(gy, s.y + s.vy * dt);
    if (s.y === gy) { s.grounded = true; s.vy = 0; }
  }
  world.finishStep?.(s);
  return s;
}

/**
 * Agent-side helper: an intent that walks toward `target` (x, z) and stops within `arrive` metres.
 * Same input the keyboard produces, so an agent drives `step` without touching it.
 */
export function moveToIntent(s: WalkerState, target: Vec2, arrive = 0.4, run = false): { input: WalkInput; arrived: boolean } {
  const dx = target[0] - s.x;
  const dz = target[1] - s.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= arrive) return { input: { forward: 0, strafe: 0, turn: 0, run: false }, arrived: true };
  const want = Math.atan2(dx, dz);
  const off = Math.abs(angleTo(s.heading, want));
  // Turn first when badly misaligned, then walk (fade in with alignment).
  const forward = off > 1.2 ? 0 : clamp(1 - off / 1.2, 0.2, 1);
  return { input: { forward, strafe: 0, turn: 0, run, faceHeading: want }, arrived: false };
}

/**
 * Free standing spot near (cx, cz): level ground at plaza height, no wall within `clear`, and NOTHING solid above the feet within the
 * body height. The last check is what the first version missed: the Bazaar fountain is a raised platform of one-sided quads, so a
 * ray started at 0.65 m passed under its top (1.1 m) and the bot spawned INSIDE it (only the torso showed).
 */
export function findSpawn(
  world: World,
  opts: { cx?: number; cz?: number; groundMin?: number; groundMax?: number; maxR?: number; clear?: number; headroom?: number } = {},
): { x: number; y: number; z: number } | null {
  const { cx = 0, cz = 0, groundMin = 0.1, groundMax = 0.3, maxR = 40, clear = 0.9, headroom = 2.2 } = opts;
  for (let r = 0; r <= maxR; r += 1.5) {
    const n = r === 0 ? 1 : Math.ceil((r * Math.PI * 2) / 1.5);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = cx + Math.sin(a) * r;
      const z = cz + Math.cos(a) * r;
      const g = world.groundY(x, z, groundMax + 0.35);
      if (g === null || g < groundMin || g > groundMax) continue;
      const top = world.groundY(x, z, g + headroom);       // highest surface within head height: must be the ground itself
      if (top === null || top > g + 0.05) continue;
      if (world.blocked([x, g, z], [x, g, z], clear)) continue;
      return { x, y: g, z };
    }
  }
  return null;
}
