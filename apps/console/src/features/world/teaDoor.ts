/**
 * Tea House door pilot — pure door machine + performance choreography.
 *
 * One door only: the Matchmaker's Tea House (city3 room "tea", front S),
 * a double leaf at [-22.9167, -72.5] in the Bazaar. Every constant here
 * traces to the measured record in ~/workspace/.build-tmp/door-plan/:
 *  - SURVEY.md: door instance, wall opening, open collision gap.
 *  - REACH-STUDY.md: FK over the baked OpenDoor clips — LEFT hand
 *    reaches, grasp contact/settle fractions, knob height 0.80 m above
 *    local ground, knob lateral K = -0.20 m on this double, stand
 *    distances ~0.30 m off the leaf face, Inwards has no push,
 *    Outwards has a real pull. Per-clip grasp numbers below are the
 *    study's Summer FK reads (seconds at 60 Hz over the baked clips).
 *
 * Two measured deviations from the study's single-leaf abstraction,
 * both forced by the real double geometry (see PILOT-BUILD.md):
 *  1. BOTH leaves swing. One open leaf leaves a 0.62-0.72 m slot; the
 *     walk capsule is 0.8 m wide — a one-leaf opening cannot pass the
 *     bot. The active (left, knob-carrying) leaf leads on the clip
 *     clock; the passive leaf follows with a small lag.
 *  2. The interior stand pose is derived from the ONE physical knob.
 *     The study's Outwards lateral (-0.33 own-frame) presupposes a
 *     mirrored knob — a knob on the character's left from both sides.
 *     A real door has one knob, so the interior pose follows from the
 *     knob itself: hand placed on it with the study's Outwards grasp
 *     offsets (fwd 0.243, lat +0.130 — the FK-measured hand-vs-knob
 *     offset), which reproduces the street pose to the study's mm.
 *  3. The knob's "local ground" is the 0.48 m plinth the performer
 *     stands on (district collision col_heroes: the tea room floor
 *     and its threshold strip), not the 0.20 street — the survey's
 *     owed interior-floor check, settled by the pilot's floor proof.
 *     Knob world Y = 0.48 + 0.80 = 1.28. See TEA_FLOOR_Y.
 *
 * Hinge: the ACTIVE leaf hinges at its own jamb (local x = -0.70).
 * The knob (K = -0.20) sits on that leaf; a leaf can only swing on the
 * hinge at its own edge. (The study's "hinge on the character's right"
 * describes which side the SINGLE-leaf swing clears toward; with the
 * knob on the left leaf, hinge-left is the only buildable reading and
 * it matches the study's stand table exactly.)
 *
 * Blocker rule: the doorway blocker (a capsule-world box registered by
 * the wiring layer) is present exactly while the leaf is below the
 * clear angle AND no operate session is running. The stand poses sit
 * ~0.30 m off the leaf faces — inside capsule radius of a plane
 * blocker — and the step-through begins while the leaf is still below
 * 80°, so during a session the choreography + the FK clearance proof
 * govern, not the box. With no session the brief's rule holds
 * verbatim: shut or closing door blocks, >= 80° lifts the blocker.
 */

import { angleTo, moveToIntent, type WalkInput, type WalkerState } from "./walker";
import type { WalkDoorClip } from "./walkOverride";

/** Room id in city3 index (rooms/tea). */
export const TEA_ROOM_ID = "tea";

/** Door instance origin, decoded from world-city3.glb (inst_door_double
 * instance #6): translation [-22.916687, 0.2, -72.5], identity rotation.
 * Door-local axes = world axes: +x is the street-facing character's
 * right, +z toward the street (front S), ground y = 0.2. */
export const TEA_DOOR_ORIGIN = { x: -22.9167, z: -72.5 } as const;
export const TEA_GROUND_Y = 0.2;

/** The floor the performer actually stands on at this door, measured
 * from the district collision GLB (pilot floor proof): col_ground is
 * 0.20 everywhere, but col_heroes carries a 0.48 plinth across the
 * whole tea room AND the threshold strip in front of the door — the
 * bot stands at 0.48 on BOTH sides of the leaf while performing (the
 * street beyond the strip and the room's floor story are 0.20 / 0.48
 * respectively; step up/down is 0.28, inside the walker's 0.4 step).
 * The study's knob constant is "0.80 m above local ground" — the
 * local ground at THIS door is the plinth, so the knob centre sits at
 * world Y 1.28 (leaf-local 1.08), not the 1.00 a 0.20 stance would
 * give. Same grasp geometry, shifted: the FK proof re-verified the
 * gate with feet at 0.48. */
export const TEA_FLOOR_Y = 0.48;

/** Leaf-slab faces, door-local z (survey triangle dump of DI_2):
 * street face -0.08, interior face -0.21, slab mid -0.145. */
export const TEA_FACE_STREET_Z = -0.08;
export const TEA_FACE_INTERIOR_Z = -0.21;
export const TEA_SLAB_MID_Z = -0.145;
/** Hinge lines, door-local x: active (left) -0.70, passive +0.70. */
export const TEA_HINGE_ACTIVE_X = -0.7;
export const TEA_HINGE_PASSIVE_X = 0.7;
/** Knob: door-local x (study K for the tea double), height above local
 * ground, and the two face centres (0.06 m proud of each face). */
export const TEA_KNOB_X = -0.2;
export const TEA_KNOB_HEIGHT = 0.8;
export const TEA_KNOB_STREET_Z = TEA_FACE_STREET_Z + 0.06;
export const TEA_KNOB_INTERIOR_Z = TEA_FACE_INTERIOR_Z - 0.06;

/** World knob height: 0.80 above the plinth the performer stands on. */
export const TEA_KNOB_WORLD_Y = TEA_FLOOR_Y + TEA_KNOB_HEIGHT;

/** World knob centres (street / interior faces), for the FK proof. */
export const TEA_KNOB_WORLD = {
  street: {
    x: TEA_DOOR_ORIGIN.x + TEA_KNOB_X,
    y: TEA_KNOB_WORLD_Y,
    z: TEA_DOOR_ORIGIN.z + TEA_KNOB_STREET_Z,
  },
  interior: {
    x: TEA_DOOR_ORIGIN.x + TEA_KNOB_X,
    y: TEA_KNOB_WORLD_Y,
    z: TEA_DOOR_ORIGIN.z + TEA_KNOB_INTERIOR_Z,
  },
} as const;

/** Leaf angles: closed 0, fully open 95 (past perpendicular so the
 * capsule passes clean), blocker clear angle 80 (the brief's ~80°). */
export const TEA_OPEN_ANGLE = 95;
export const TEA_CLEAR_ANGLE = 80;
/** Passive leaf follow rate (deg/s) — lags the active leaf slightly
 * (fast enough to stay out of the step-through path; the FK clearance
 * proof models it as a ~0.06 s delay). */
const PASSIVE_FOLLOW_RATE = 300;
/** Closing speed (deg/s) once the doorway is unoccupied. */
const CLOSE_RATE = 55;
/** HUD request range: the bot must be within this of its stand pose. */
export const TEA_REQUEST_RANGE = 2.5;
/** Auto-open: the player is walking at the door within this distance of its plane (m)... */
export const TEA_AUTO_RANGE = 1.8;
/** ...and within this half-width of its centre line (m)... */
const TEA_AUTO_HALF_WIDTH = 0.9;
/** ...facing it within this (cos of the angle; 0.8 = 37 degrees). */
const TEA_AUTO_FACING = 0.8;

/**
 * Which door clip a player walking forward at the tea door should trigger, or null. Pure: position, view heading and
 * whether the player is pushing forward. From the street (z above the door plane) facing -z it is Inwards; from inside
 * facing +z it is Outwards. Walking past, backing off or standing still never triggers it.
 */
export function teaAutoClip(s: Pick<WalkerState, "x" | "z" | "heading">, wantsForward: boolean): WalkDoorClip | null {
  if (!wantsForward) return null;
  if (Math.abs(s.x - TEA_DOOR_ORIGIN.x) > TEA_AUTO_HALF_WIDTH) return null;
  const dz = s.z - TEA_DOOR_ORIGIN.z; // > 0: street side
  if (Math.abs(dz) > TEA_AUTO_RANGE) return null;
  const facingZ = Math.cos(s.heading);
  if (dz > 0 && facingZ < -TEA_AUTO_FACING) return "OpenDoorInwards";
  if (dz < 0 && facingZ > TEA_AUTO_FACING) return "OpenDoorOutwards";
  return null;
}

/** Auto-close dwell: door stays open this long after the last
 * occupancy before it starts closing. */
const AUTOCLOSE_DELAY = 0.8;
/** Step-through exit: this far past the far leaf face. */
const EXIT_PAST_FACE = 1.2;

interface GraspProfile {
  /** Clip duration (s), from the catalog. */
  duration: number;
  /** Hand reaches the knob (s). */
  contactAt: number;
  /** Grasp settled (s) — the FK gate moment. */
  settledAt: number;
  /** Hand leaves the knob (s). */
  releaseAt: number;
  /** Grasp offsets: hand position in the body frame at settle —
   * forward (m ahead of the body axis) and lateral (m along the
   * body's right vector R = (-cos h, sin h)). FK-measured, study §3. */
  graspFwd: number;
  graspLat: number;
  /** Console starts driving the step-through at this clip time (s). */
  travelAt: number;
}

/** Per-clip grasp profiles — REACH-STUDY.md §3 (Summer, fixed body).
 * Inwards: contact 61% (3.90 s), settle 69% (4.40 s), hand holds
 * ~0.25 s then the turn releases it (~4.66 s); NO push afterwards.
 * Outwards: contact ~58% (2.40 s), settle 62% (2.55 s), real pull —
 * the hand retracts ~0.29 m; release ~2.72 s. */
export const TEA_GRASP: Record<WalkDoorClip, GraspProfile> = {
  OpenDoorInwards: {
    duration: 6.3667,
    contactAt: 3.9,
    settledAt: 4.4,
    releaseAt: 4.66,
    graspFwd: 0.245,
    graspLat: -0.337,
    travelAt: 4.85,
  },
  OpenDoorOutwards: {
    duration: 4.1,
    contactAt: 2.4,
    settledAt: 2.55,
    releaseAt: 2.72,
    graspFwd: 0.243,
    graspLat: 0.13,
    travelAt: 2.85,
  },
};

/** Outwards pull peak (deg at release). The study's 0.29 m hand
 * retraction is measured in the BODY frame; the FK theta-star proof
 * (pilot/fk_theta_star.py) projects the actual palm path onto the
 * knob's hinge arc: the palm stays on the CLOSED knob until ~2.6 s
 * and the best-tracking angle at release is only ~9-10 deg (the rest
 * of the retraction is the pre-turned body carrying the hand away).
 * 10 deg it is — an early asin(0.29/0.50) ~= 35 deg estimate was
 * measured and rejected (residual 0.24 m vs 0.075 m best-possible). */
export const TEA_PULL_PEAK_ANGLE = 10;

export interface StandPose {
  x: number;
  z: number;
  /** World heading (walker convention: faces (sin h, cos h)). */
  heading: number;
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const easeInOut = (t: number) => {
  const u = clamp01(t);
  return u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
};

/**
 * Stand pose for a clip, solved from the physical knob: the bot
 * stands so its LEFT hand lands on the knob with the study's grasp
 * offsets. Heading PI faces the door from the street (Inwards);
 * heading 0 faces it from inside (Outwards). Reproduces the study's
 * stand table on the street side (fwd 0.305/lat +0.137 vs the study's
 * 0.31/+0.14 measured off the leaf face).
 */
export function teaStandPose(clip: WalkDoorClip): StandPose {
  const g = TEA_GRASP[clip];
  const inwards = clip === "OpenDoorInwards";
  const knob = inwards ? TEA_KNOB_WORLD.street : TEA_KNOB_WORLD.interior;
  const heading = inwards ? Math.PI : 0;
  // hand = pos + graspFwd * F + graspLat * R, F = (sin h, cos h),
  // R = (-cos h, sin h). Solve pos so hand == knob.
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  const rx = -Math.cos(heading);
  const rz = Math.sin(heading);
  return {
    x: knob.x - g.graspFwd * fx - g.graspLat * rx,
    z: knob.z - g.graspFwd * fz - g.graspLat * rz,
    heading,
  };
}

/** Step-through exit point: door centre line, EXIT_PAST_FACE past the
 * far leaf face (inside the room for Inwards, on the street for
 * Outwards). */
export function teaExitPoint(clip: WalkDoorClip): { x: number; z: number } {
  const inwards = clip === "OpenDoorInwards";
  const farFace = inwards ? TEA_FACE_INTERIOR_Z : TEA_FACE_STREET_Z;
  const dir = inwards ? -1 : 1;
  return {
    x: TEA_DOOR_ORIGIN.x,
    z: TEA_DOOR_ORIGIN.z + farFace + dir * EXIT_PAST_FACE,
  };
}

const smoothstep = (t: number) => {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
};

/** Active-leaf angle (deg) at clip time t for a performance. Both
 * curves are fitted to the FK theta-star proof, not to intuition:
 * theta*(t) is the angle whose knob position is closest to the palm.
 * Inwards theta* = 0 for the whole contact window (the hand settles
 * on the closed knob, holds, then leaves sideways with the pelvis
 * turn — no angle tracks it). Outwards theta* stays ~0 until ~2.6 s
 * then rises to ~9-10 deg at release. */
export function teaLeafAngleAt(clip: WalkDoorClip, t: number): number {
  const g = TEA_GRASP[clip];
  if (clip === "OpenDoorInwards") {
    // No push in this clip and theta* = 0 while the hand is on the
    // knob: the leaf stays shut until release, then swings free
    // inside the turn/step-through window (fast enough that the
    // panels are flat to the walls as the bot crosses the plane).
    if (t <= g.releaseAt) return 0;
    if (t <= 5.7) return TEA_OPEN_ANGLE * easeInOut((t - g.releaseAt) / 1.04);
    return TEA_OPEN_ANGLE;
  }
  // Outwards: leaf slaved to the pull (theta* fit), then free.
  if (t <= 2.52) return 0;
  if (t <= g.releaseAt) return TEA_PULL_PEAK_ANGLE * smoothstep((t - 2.52) / 0.2);
  if (t <= 2.8) return TEA_PULL_PEAK_ANGLE;
  if (t <= 3.55)
    return (
      TEA_PULL_PEAK_ANGLE +
      (TEA_OPEN_ANGLE - TEA_PULL_PEAK_ANGLE) * easeInOut((t - 2.8) / 0.75)
    );
  return TEA_OPEN_ANGLE;
}

/** The capsule-world blocker box for the tea doorway (ColBox tuple:
 * [cx, cz, hx, hz, y0, y1, rotY]) — spans the double opening plus a
 * capsule margin, slab depth, floor to lintel. */
export const TEA_BLOCKER_BOX: [number, number, number, number, number, number, number] = [
  TEA_DOOR_ORIGIN.x,
  TEA_DOOR_ORIGIN.z + TEA_SLAB_MID_Z,
  0.78,
  0.1,
  TEA_GROUND_Y,
  TEA_GROUND_Y + 2.4,
  0,
];

/** Doorway occupancy zone (auto-close guard): a capsule whose centre
 * is inside this box is in the leaf sweep or the doorway — the door
 * never swings onto it. */
export function teaDoorwayOccupied(x: number, z: number): boolean {
  return (
    Math.abs(x - TEA_DOOR_ORIGIN.x) < 1.15 &&
    z > TEA_DOOR_ORIGIN.z - 1.0 &&
    z < TEA_DOOR_ORIGIN.z + 0.9
  );
}

export type TeaDoorState = "closed" | "opening" | "open" | "closing";
export type TeaSessionPhase = "idle" | "align" | "perform" | "travel";
export type TeaRequestResult =
  | "started"
  | "too-far"
  | "wrong-side"
  | "busy"
  | "already-open";

/** The clip channel the controller fires through — structurally the
 * #31 WalkClipOverride (fireDoor + doorPlaying), injected so the
 * machine stays pure and testable. */
export interface TeaDoorChannel {
  fireDoor(name: WalkDoorClip): boolean;
  readonly doorPlaying: boolean;
}

/** Inside this distance (m) of the stand pose the bot stops walking toward it and shuffles into place facing the door. */
const FINE_ALIGN_RADIUS = 0.6;

/**
 * Align-phase input. Far from the pose: walk to it (turn, then go). Near it: hold the pose heading and move in the
 * POSE's frame (forward / strafe / backward), so the bot never turns round to chase a point a few centimetres away.
 * (The first version kept facing the target; walking in at 1.3 m/s it overshot, turned to go back, and hunted for ever.)
 */
export function alignInput(s: WalkerState, pose: StandPose): WalkInput {
  const ex = pose.x - s.x;
  const ez = pose.z - s.z;
  const dist = Math.hypot(ex, ez);
  if (dist > FINE_ALIGN_RADIUS) return moveToIntent(s, [pose.x, pose.z], 0.02).input;
  const sn = Math.sin(s.heading);
  const cs = Math.cos(s.heading);
  // The walker's world velocity is (sn*f - cs*r, cs*f + sn*r): solve f and r for the wanted displacement.
  let f = ex * sn + ez * cs;
  let r = -ex * cs + ez * sn;
  const m = Math.hypot(f, r);
  if (m > 1e-6) {
    const k = Math.min(1, Math.max(0.12, m * 2.5)) / m; // slow down into the pose, never stall short of it
    f *= k;
    r *= k;
  }
  if (dist <= 0.015) { f = 0; r = 0; }
  return { forward: f, strafe: r, turn: 0, run: false, faceHeading: pose.heading };
}

const ZERO_INPUT: WalkInput = { forward: 0, strafe: 0, turn: 0, run: false };

/**
 * Tea door state machine + session driver. One instance per walk
 * session (wired in GlbWorld): CityWalker calls drive() every frame
 * with the live walker state; it returns the input to step with, or
 * null for "use the player's keys". The HUD calls request().
 */
export class TeaDoorController {
  state: TeaDoorState = "closed";
  phase: TeaSessionPhase = "idle";
  /** Active leaf angle, degrees, 0..95. */
  angle = 0;
  /** Passive leaf angle, degrees (follows the active leaf). */
  passiveAngle = 0;
  /** Last request rejection, for the HUD status line. */
  lastRefusal: { clip: WalkDoorClip; reason: string; at: number } | null = null;

  private readonly channel: TeaDoorChannel;
  private readonly setBlocker: (active: boolean) => void;
  private blockerOn: boolean | null = null;
  private clip: WalkDoorClip | null = null;
  private clipT = 0;
  private bot: { x: number; z: number } | null = null;
  private freeTimer = 0;
  private now = 0;

  constructor(deps: { channel: TeaDoorChannel; setBlocker: (active: boolean) => void }) {
    this.channel = deps.channel;
    this.setBlocker = deps.setBlocker;
    this.syncBlocker();
  }

  /** Blocker rule (see header): leaf below clear angle AND no session. */
  blockerActive(): boolean {
    return this.angle < TEA_CLEAR_ANGLE && this.phase === "idle";
  }

  private syncBlocker(): void {
    const want = this.blockerActive();
    if (want !== this.blockerOn) {
      this.blockerOn = want;
      this.setBlocker(want);
    }
  }

  /** HUD entry point. Validates range/side/state, starts the align
   * phase; the performance itself is driven frame by frame. */
  request(clip: WalkDoorClip): TeaRequestResult {
    if (this.phase !== "idle") return this.refuse(clip, "busy");
    if (this.state === "open" || this.state === "closing")
      return this.refuse(clip, "already-open");
    if (this.state !== "closed") return this.refuse(clip, "busy");
    if (!this.bot) return this.refuse(clip, "too-far", "too far");
    const pose = teaStandPose(clip);
    const dist = Math.hypot(this.bot.x - pose.x, this.bot.z - pose.z);
    if (dist > TEA_REQUEST_RANGE)
      return this.refuse(clip, "too-far", `too far (${dist.toFixed(1)} m)`);
    // Correct side: the bot must be on the pose's side of the door plane.
    const planeZ = TEA_DOOR_ORIGIN.z;
    if ((this.bot.z - planeZ) * (pose.z - planeZ) < 0)
      return this.refuse(clip, "wrong-side", "wrong side");
    this.clip = clip;
    this.clipT = 0;
    this.phase = "align";
    this.lastRefusal = null;
    this.syncBlocker();
    return "started";
  }

  private refuse(
    clip: WalkDoorClip,
    result: TeaRequestResult,
    label: string = result,
  ): TeaRequestResult {
    this.lastRefusal = { clip, reason: label, at: this.now };
    return result;
  }

  private atPose(s: WalkerState, pose: StandPose): boolean {
    const d = Math.hypot(s.x - pose.x, s.z - pose.z);
    return (
      d <= 0.035 &&
      Math.abs(angleTo(s.heading, pose.heading)) <= 0.03 &&
      Math.abs(angleTo(s.body, pose.heading)) <= 0.06
    );
  }

  private arrived(s: WalkerState, p: { x: number; z: number }): boolean {
    return Math.hypot(s.x - p.x, s.z - p.z) <= 0.15;
  }

  /**
   * Per-frame driver. Returns the WalkInput to step with this frame,
   * or null when the player keeps control (no session). Also advances
   * the door machine (swing, auto-close) and the blocker.
   */
  drive(s: WalkerState, dt: number, wantsForward = false): WalkInput | null {
    this.now += dt;
    this.bot = { x: s.x, z: s.z };
    let input: WalkInput | null = null;

    // Walking at a shut door starts the performance by itself (the HUD buttons stay as a manual override).
    if (this.phase === "idle" && this.state === "closed") {
      const auto = teaAutoClip(s, wantsForward);
      if (auto) this.request(auto);
    }

    if (this.phase === "align" && this.clip) {
      const pose = teaStandPose(this.clip);
      if (this.atPose(s, pose)) {
        // Facing settled: fire the clip; the performance clock starts.
        if (this.channel.fireDoor(this.clip)) {
          this.phase = "perform";
          this.clipT = 0;
          this.state = "opening";
        } else {
          this.phase = "idle";
          this.clip = null;
        }
        input = ZERO_INPUT;
      } else {
        input = alignInput(s, pose);
      }
    } else if (this.phase === "perform" && this.clip) {
      const g = TEA_GRASP[this.clip];
      this.clipT += dt;
      // The one-shot runs on the figure's own frame clock; if it has already ended (slow frames), do not lag behind it.
      if (!this.channel.doorPlaying && this.clipT > 0.25) this.clipT = Math.max(this.clipT, g.travelAt);
      this.angle = teaLeafAngleAt(this.clip, this.clipT);
      if (this.clipT >= g.travelAt || this.clipT >= g.duration) {
        this.phase = "travel";
        input = moveToIntent(s, teaExitArray(this.clip), 0.1).input;
      } else {
        input = ZERO_INPUT;
      }
    } else if (this.phase === "travel" && this.clip) {
      const g = TEA_GRASP[this.clip];
      this.clipT += dt;
      this.angle = teaLeafAngleAt(this.clip, Math.min(this.clipT, g.duration + 2));
      const exit = teaExitPoint(this.clip);
      if (this.arrived(s, exit) && this.clipT >= g.duration - 0.05) {
        this.phase = "idle";
        this.clip = null;
        this.state = "open";
        this.angle = TEA_OPEN_ANGLE;
        input = ZERO_INPUT;
      } else if (this.clipT > g.duration + 2.5) {
        // Give up gracefully: door open, control back to the player.
        this.phase = "idle";
        this.clip = null;
        this.state = "open";
        input = ZERO_INPUT;
      } else {
        input = moveToIntent(s, [exit.x, exit.z], 0.1).input;
      }
    }

    // Passive leaf follows the active one with a lag.
    const diff = this.angle - this.passiveAngle;
    const stepMax = PASSIVE_FOLLOW_RATE * dt;
    this.passiveAngle += Math.max(-stepMax, Math.min(stepMax, diff));

    // Auto-close: only from a settled open state, doorway unoccupied
    // and the bot clear of the door plane.
    if (this.phase === "idle" && this.state === "open") {
      const occupied = this.bot ? teaDoorwayOccupied(this.bot.x, this.bot.z) : true;
      const clearOfPlane =
        this.bot !== null && Math.abs(this.bot.z - TEA_DOOR_ORIGIN.z) > 1.0;
      if (!occupied && clearOfPlane) {
        this.freeTimer += dt;
        if (this.freeTimer >= AUTOCLOSE_DELAY) this.state = "closing";
      } else {
        this.freeTimer = 0;
      }
    }
    if (this.state === "closing") {
      this.angle = Math.max(0, this.angle - CLOSE_RATE * dt);
      this.passiveAngle = Math.max(0, this.passiveAngle - CLOSE_RATE * dt);
      if (this.angle <= 0) {
        this.angle = 0;
        this.passiveAngle = 0;
        this.state = "closed";
        this.freeTimer = 0;
      }
    }

    this.syncBlocker();
    return input;
  }

  /** Short status for the walk HUD ("tea door · …"), or null when
   * there is nothing to say. */
  status(): string | null {
    if (this.phase === "align") return "tea door · aligning…";
    if (this.phase === "perform" || this.phase === "travel")
      return "tea door · opening…";
    if (this.state === "open") return "tea door · open";
    if (this.state === "closing") return "tea door · closing…";
    if (this.lastRefusal && this.now - this.lastRefusal.at < 4)
      return `tea door · ${this.lastRefusal.reason}`;
    return null;
  }
}

function teaExitArray(clip: WalkDoorClip): [number, number] {
  const e = teaExitPoint(clip);
  return [e.x, e.z];
}
