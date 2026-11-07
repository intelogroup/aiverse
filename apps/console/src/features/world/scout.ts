// scout.ts — Phase 0 of the City 3 free-exploration agent experiment: the
// pure core of the "Scout" harness (see .build-tmp/agent-experiment/PLAN.md).
//
// Three-free and DOM-free, same discipline as walker.ts / embody.ts. This
// module owns everything the runner's decision loop needs that is NOT
// rendering:
//   - the blackboard's derived facts (nearest place, room containment,
//     district) from the walker's live state;
//   - the ORACLE look: known world geometry (places, room doors) projected
//     into Scout's frame — v1 perception per the plan's belief-map
//     amendment (oracle first; image-derived depth is v2);
//   - the action executor: a state machine that drives walker.ts with
//     synthesized intents (the same seam the keyboard uses), with
//     arrived / blocked / timeout outcomes, the sit choreography over the
//     generator's registered sittables, and the social clip subset.
//
// The React shell (ScoutAgent.tsx) owns the body, the camera and
// window.__scout; it feeds this executor the collision World and ticks it
// per frame. Unit tests drive the executor against fake worlds.

import { clipDef } from "./clips";
import {
  angleTo,
  moveToIntent,
  step,
  type Vec2,
  type WalkerState,
  type World,
} from "./walker";

/** A named, go-to-able spot in the Bazaar (from city3-places.json). */
export interface ScoutPlace {
  id: string;
  kind: "stall" | "shopfront" | "hall";
  name: string;
  /** The place's own position (a stall's structure centre, a shopfront's
   *  door point): what the oracle projects and "nearest" measures. */
  pos: Vec2;
  /** Where a visitor actually arrives: a stall's pos is inside its
   *  collision (a walker stalls 2.4 m out, measured), so stalls stand
   *  off 2.8 m on their customer side; shopfronts stand at the door. */
  stand: Vec2;
  heading: number;
  /** Interior room id for shopfronts. */
  room?: string;
  /** Door point for shopfronts (== pos; kept explicit for the oracle). */
  door?: Vec2;
}

/** Structural subset of city3.ts's City3Room (kept local so this module
 *  does not pull the asset-loading module into unit tests). */
export interface ScoutRoomShape {
  id: string;
  name: string;
  door: Vec2;
  rect: [number, number, number, number];
  center: Vec2;
}

export interface ScoutDistrict {
  id: string;
  name: string;
  center: Vec2;
  half: number;
}

/**
 * A registered sittable: one record of the world generator's anchor set
 * (tools/city3/out/hero-anchors.json, kit.ANCHORS), shipped to the console
 * as city3-anchors.json. Seat heights were independently verified against
 * the library geometry; approach points are generator-guaranteed clear of
 * every furniture collision box (tools/city3/col_interiors.py).
 */
export interface Sittable {
  id: string;
  building: string;
  kind: string;
  seat: Vec2;
  /** Heading the seated figure faces (walker convention). */
  facing: number;
  /** Stand point: the seat offset 0.62 m along +/- facing (approachSide). */
  approach: Vec2;
  approachSide: "front" | "back";
  /** Seat height above the room floor, m. */
  seatHeight: number;
  /** Absolute height of the room floor, m. */
  floorY: number;
}

// ---------------------------------------------------------------------------
// Blackboard derivations

export function nearestPlace(places: ScoutPlace[], x: number, z: number): { place: ScoutPlace; dist: number } | null {
  let best: ScoutPlace | null = null;
  let bd = Infinity;
  for (const p of places) {
    const d = Math.hypot(p.pos[0] - x, p.pos[1] - z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best ? { place: best, dist: bd } : null;
}

/** The room whose rect contains (x, z), if any. */
export function roomAt(rooms: ScoutRoomShape[], x: number, z: number): ScoutRoomShape | null {
  for (const r of rooms) {
    const [x0, z0, x1, z1] = r.rect;
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return r;
  }
  return null;
}

/** District containing (x, z); falls back to the nearest centre. */
export function districtAt(districts: ScoutDistrict[], x: number, z: number): ScoutDistrict | null {
  let nearest: ScoutDistrict | null = null;
  let nd = Infinity;
  for (const d of districts) {
    if (Math.abs(x - d.center[0]) <= d.half && Math.abs(z - d.center[1]) <= d.half) return d;
    const dist = Math.hypot(d.center[0] - x, d.center[1] - z);
    if (dist < nd) {
      nd = dist;
      nearest = d;
    }
  }
  return nearest;
}

// ---------------------------------------------------------------------------
// Oracle projection (the v1 "look" scene)

/**
 * Signed bearing of a world offset in Scout's frame, degrees. Heading h
 * faces (sin h, cos h); a point at absolute angle a = atan2(dx, dz) has
 * bearing wrap(a - h). Positive = toward +x when facing +z (Scout's left
 * hand in three.js's y-up right-handed space). The decider only needs the
 * number with this note attached.
 */
export function bearingDeg(heading: number, dx: number, dz: number): number {
  const a = Math.atan2(dx, dz);
  const deg = ((a - heading) * 180) / Math.PI;
  return ((deg + 540) % 360) - 180;
}

export interface OracleObject {
  kind: "place" | "door" | "room";
  id: string;
  name: string;
  bearingDeg: number;
  distance: number;
  /** Doors are enterable by walking through them. */
  enterable?: boolean;
  note?: string;
}

export interface OracleOpts {
  range?: number;
  halfFovDeg?: number;
}

/**
 * Project known world data into Scout's frame: places and room doors within
 * `range` and the view cone, plus the room Scout is inside (always known).
 * Touch-range objects (<= 2.5 m) are perceived regardless of the cone.
 */
export function oracleScene(
  places: ScoutPlace[],
  rooms: ScoutRoomShape[],
  self: { x: number; z: number; heading: number },
  opts: OracleOpts = {},
): OracleObject[] {
  const range = opts.range ?? 25;
  const halfFov = opts.halfFovDeg ?? 65;
  const out: OracleObject[] = [];
  const seen = (wx: number, wz: number) => {
    const dx = wx - self.x;
    const dz = wz - self.z;
    const distance = Math.hypot(dx, dz);
    if (distance > range) return null;
    const b = bearingDeg(self.heading, dx, dz);
    if (Math.abs(b) > halfFov && distance > 2.5) return null;
    return { bearingDeg: Math.round(b * 10) / 10, distance: Math.round(distance * 100) / 100 };
  };
  const inside = roomAt(rooms, self.x, self.z);
  if (inside) {
    out.push({ kind: "room", id: inside.id, name: inside.name, bearingDeg: 0, distance: 0, note: "you are inside" });
  }
  for (const p of places) {
    const s = seen(p.pos[0], p.pos[1]);
    if (s) out.push({ kind: "place", id: p.id, name: p.name, ...s });
  }
  for (const r of rooms) {
    if (inside && r.id === inside.id) continue;
    const s = seen(r.door[0], r.door[1]);
    if (s) out.push({ kind: "door", id: r.id, name: `${r.name} door`, enterable: true, ...s });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

// ---------------------------------------------------------------------------
// Actions

/** The social clip subset a decider may fire with `play` (plan, Phase 0). */
export const SOCIAL_CLIPS = ["Talking", "Waving", "LookingAround", "Pointing", "NodYes", "Shrug", "Clapping"] as const;
export type SocialClip = (typeof SOCIAL_CLIPS)[number];

export type ScoutAction =
  | { type: "go_to"; place?: string; point?: Vec2 }
  | { type: "run_to"; place?: string; point?: Vec2 }
  | { type: "face"; point?: Vec2; headingDeg?: number }
  | { type: "wait"; seconds: number }
  | { type: "sit"; sittable?: string }
  | { type: "stand" }
  | { type: "play"; clip: string; seconds?: number }
  | { type: "say"; text: string }
  | { type: "finish" };

export type OutcomeStatus =
  | "arrived"
  | "done"
  | "blocked"
  | "timeout"
  | "unavailable"
  | "rejected"
  | "seated"
  | "stood";

export interface ScoutOutcome {
  ok: boolean;
  status: OutcomeStatus;
  detail?: string;
  /** Place or sittable id the action resolved against, when applicable. */
  target?: string;
}

export type Posture = "standing" | "sitting-down" | "seated" | "standing-up";

/** Max distance from Scout at which `sit` will engage a sittable (the
 *  executor walks to its approach point itself). */
export const SIT_ENGAGE_RANGE = 30;

export function sittableById(sittables: Sittable[], id: string): Sittable | undefined {
  return sittables.find((s) => s.id === id);
}

/** Nearest sittable (by approach point) to (x, z) within `range`, or null. */
export function nearestSittable(sittables: Sittable[], x: number, z: number, range = SIT_ENGAGE_RANGE): Sittable | null {
  let best: Sittable | null = null;
  let bd = Infinity;
  for (const s of sittables) {
    const d = Math.hypot(s.approach[0] - x, s.approach[1] - z);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best && bd <= range ? best : null;
}

// ---------------------------------------------------------------------------
// Executor

type SitPhase = "to-approach" | "turn" | "down" | "up";

interface Pending {
  action: ScoutAction;
  resolve: (o: ScoutOutcome) => void;
  /** Seconds left before the action times out (or completes, for wait/play). */
  tLeft: number;
  target?: Vec2;
  targetId?: string;
  run?: boolean;
  bestDist: number;
  staleFor: number;
  lastX: number;
  lastZ: number;
  faceTarget?: number;
  sittable?: Sittable;
  phase?: SitPhase;
  phaseT?: number;
}

const SIT_DOWN_S = clipDef("SitDown")?.duration ?? 2.2333;
const STAND_UP_S = clipDef("StandUp")?.duration ?? 2.2667;
const ZERO_INPUT = { forward: 0, strafe: 0, turn: 0, run: false };

export interface ExecutorDeps {
  places: ScoutPlace[];
  sittables: Sittable[];
  /** The figure's clip tester (clips.ts): the executor fires sit/play clips. */
  clips: { fire: (name: string) => boolean; current: string | null };
  /** The body's measured hips height (for the seated drop in frameOverride). */
  hipsY: number;
}

/**
 * Drives one WalkerState through ScoutActions. One action at a time; a
 * second submission is rejected immediately. tick(dt) advances the walker
 * through the collision World and resolves the pending action's promise on
 * completion. During a sit transition (and while seated) the walker is
 * PARKED — frameOverride() gives the figure's render transform instead.
 */
export class ScoutExecutor {
  /** Elapsed harness clock, seconds since construction. */
  t = 0;
  posture: Posture = "standing";
  finished = false;
  private pending: Pending | null = null;
  private seatedOn: Sittable | null = null;
  private sitBlend = 0;
  private deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  get currentAction(): ScoutAction | null {
    return this.pending?.action ?? null;
  }

  get seatedSittable(): Sittable | null {
    return this.seatedOn;
  }

  submit(action: ScoutAction, state: WalkerState): Promise<ScoutOutcome> {
    if (this.finished && action.type !== "finish") {
      return Promise.resolve({ ok: false, status: "rejected", detail: "Scout has finished" });
    }
    if (this.pending) {
      return Promise.resolve({ ok: false, status: "rejected", detail: "busy" });
    }
    switch (action.type) {
      case "finish":
        this.finished = true;
        return Promise.resolve({ ok: true, status: "done" });
      case "say":
        // Logged by the shell (and captioned there if a cheap mechanism
        // exists); nothing to animate in the executor.
        return Promise.resolve({ ok: true, status: "done" });
      case "go_to":
      case "run_to": {
        if (this.posture !== "standing") {
          return Promise.resolve({ ok: false, status: "rejected", detail: "seated — stand first" });
        }
        const target = this.resolveTarget(action);
        if (!target) {
          return Promise.resolve({
            ok: false,
            status: "unavailable",
            detail: action.place ? `unknown place: ${action.place}` : "go_to needs a place or a point",
          });
        }
        const dist = Math.hypot(target.pos[0] - state.x, target.pos[1] - state.z);
        const run = action.type === "run_to";
        return this.begin(action, state, {
          target: target.pos,
          targetId: target.id,
          run,
          tLeft: Math.min(240, dist / (run ? 1.6 : 0.8) + 25),
          bestDist: dist,
        });
      }
      case "face": {
        if (this.posture === "seated") {
          return Promise.resolve({ ok: false, status: "rejected", detail: "seated" });
        }
        let faceTarget: number | undefined;
        if (action.point) faceTarget = Math.atan2(action.point[0] - state.x, action.point[1] - state.z);
        else if (action.headingDeg !== undefined) faceTarget = (action.headingDeg * Math.PI) / 180;
        if (faceTarget === undefined) {
          return Promise.resolve({ ok: false, status: "unavailable", detail: "face needs a point or headingDeg" });
        }
        return this.begin(action, state, { faceTarget, tLeft: 12 });
      }
      case "wait": {
        const seconds = Math.max(0, Math.min(120, action.seconds || 0));
        return this.begin(action, state, { tLeft: seconds });
      }
      case "play": {
        if (!SOCIAL_CLIPS.includes(action.clip as SocialClip)) {
          return Promise.resolve({ ok: false, status: "unavailable", detail: `clip not in the social subset: ${action.clip}` });
        }
        const def = clipDef(action.clip);
        if (!def) return Promise.resolve({ ok: false, status: "unavailable", detail: `unknown clip: ${action.clip}` });
        const hold = def.loop ? Math.max(0.5, Math.min(30, action.seconds ?? 4)) : def.duration;
        this.deps.clips.fire(action.clip);
        return this.begin(action, state, { tLeft: hold });
      }
      case "sit": {
        if (this.posture !== "standing") {
          return Promise.resolve({ ok: false, status: "rejected", detail: "already seated" });
        }
        const sittable = action.sittable
          ? sittableById(this.deps.sittables, action.sittable)
          : nearestSittable(this.deps.sittables, state.x, state.z);
        if (!sittable) {
          return Promise.resolve({
            ok: false,
            status: "unavailable",
            detail: action.sittable ? `unknown sittable: ${action.sittable}` : "no sittable within reach",
          });
        }
        const dist = Math.hypot(sittable.approach[0] - state.x, sittable.approach[1] - state.z);
        return this.begin(action, state, {
          sittable,
          phase: "to-approach",
          target: sittable.approach,
          targetId: sittable.id,
          run: false,
          tLeft: Math.min(180, dist / 0.8 + 30),
          bestDist: dist,
        });
      }
      case "stand": {
        if (this.posture !== "seated" || !this.seatedOn) {
          return Promise.resolve({ ok: false, status: "rejected", detail: "not seated" });
        }
        const sittable = this.seatedOn;
        this.posture = "standing-up";
        this.deps.clips.fire("StandUp");
        return this.begin(action, state, { sittable, phase: "up", phaseT: 0, tLeft: STAND_UP_S + 10 });
      }
    }
  }

  private resolveTarget(action: { place?: string; point?: Vec2 }): { pos: Vec2; id?: string } | null {
    if (action.place) {
      // Addressable by lot id ("shop-102") or by room id ("tea") — a
      // decider thinks in named rooms, the nav in lots.
      const p = this.deps.places.find((pl) => pl.id === action.place || pl.room === action.place);
      return p ? { pos: p.stand, id: p.id } : null;
    }
    if (action.point) return { pos: action.point };
    return null;
  }

  private begin(action: ScoutAction, state: WalkerState, extra: Partial<Pending> & { tLeft: number }): Promise<ScoutOutcome> {
    return new Promise<ScoutOutcome>((resolve) => {
      this.pending = {
        action,
        resolve,
        bestDist: Infinity,
        staleFor: 0,
        lastX: state.x,
        lastZ: state.z,
        ...extra,
      };
    });
  }

  private settle(outcome: ScoutOutcome): void {
    const p = this.pending;
    this.pending = null;
    p?.resolve(outcome);
  }

  /**
   * While sitting down / seated / standing up, the figure renders at the
   * seat (blended from the approach point), NOT at the parked walker state.
   * `drop` is the figure root's y offset: seatHeight - hipsY at blend 1
   * (negative: the root sinks so the hips land on the seat).
   */
  frameOverride(): { x: number; z: number; y: number; heading: number; drop: number } | null {
    if (this.posture === "standing" || !this.seatedOn) return null;
    const s = this.seatedOn;
    const k = this.posture === "seated" ? 1 : this.sitBlend;
    return {
      x: s.approach[0] + (s.seat[0] - s.approach[0]) * k,
      z: s.approach[1] + (s.seat[1] - s.approach[1]) * k,
      y: s.floorY,
      heading: s.facing,
      drop: k * (s.seatHeight - this.deps.hipsY),
    };
  }

  tick(dt: number, state: WalkerState, world: World): void {
    this.t += dt;
    const p = this.pending;

    // Sit transitions + seated: the walker is parked; only the blend moves.
    if (this.posture === "sitting-down" || this.posture === "standing-up") {
      if (p && (p.phase === "down" || p.phase === "up")) {
        p.phaseT = (p.phaseT ?? 0) + dt;
        const dur = p.phase === "down" ? SIT_DOWN_S : STAND_UP_S;
        const k = Math.min(1, (p.phaseT ?? 0) / dur);
        const ease = k * k * (3 - 2 * k);
        this.sitBlend = p.phase === "down" ? ease : 1 - ease;
        if (k >= 1) this.finishTransition(state, p);
      }
      return;
    }
    if (this.posture === "seated") {
      // Parked, but a pending wait/play still counts down (its clip was
      // fired at submit; play restores the seated idle when it ends).
      if (p && (p.action.type === "wait" || p.action.type === "play")) {
        p.tLeft -= dt;
        if (p.tLeft <= 0) {
          if (p.action.type === "play") this.deps.clips.fire("SittingIdle");
          this.settle({ ok: true, status: "done" });
        }
      }
      return;
    }

    if (!p) {
      step(state, ZERO_INPUT, dt, world);
      return;
    }

    p.tLeft -= dt;

    switch (p.action.type) {
      case "wait": {
        step(state, ZERO_INPUT, dt, world);
        if (p.tLeft <= 0) this.settle({ ok: true, status: "done" });
        return;
      }
      case "play": {
        step(state, ZERO_INPUT, dt, world);
        if (p.tLeft <= 0) {
          // Standing play ends back at locomotion (the seated case has
          // its own settle in the seated branch above).
          this.deps.clips.fire("Idle");
          this.settle({ ok: true, status: "done" });
        }
        return;
      }
      case "face": {
        if (p.tLeft <= 0) {
          this.settle({ ok: false, status: "timeout" });
          return;
        }
        step(state, { ...ZERO_INPUT, faceHeading: p.faceTarget }, dt, world);
        if (Math.abs(angleTo(state.heading, p.faceTarget!)) < 0.04) {
          this.settle({ ok: true, status: "done" });
        }
        return;
      }
      case "go_to":
      case "run_to":
      case "sit": {
        if (p.action.type === "sit" && p.phase === "turn") {
          step(state, { ...ZERO_INPUT, faceHeading: p.sittable!.facing }, dt, world);
          if (Math.abs(angleTo(state.heading, p.sittable!.facing)) < 0.05) {
            p.phase = "down";
            p.phaseT = 0;
            this.seatedOn = p.sittable!;
            this.sitBlend = 0;
            this.posture = "sitting-down";
            this.deps.clips.fire("SitDown");
          } else if (p.tLeft <= 0) {
            this.settle({ ok: false, status: "timeout", target: p.targetId });
          }
          return;
        }
        if (p.tLeft <= 0) {
          this.settle({ ok: false, status: "timeout", target: p.targetId });
          step(state, ZERO_INPUT, dt, world);
          return;
        }
        const target = p.target!;
        const arriveR = p.phase === "to-approach" ? 0.25 : 0.45;
        const { input, arrived } = moveToIntent(state, target, arriveR, !!p.run);
        step(state, input, dt, world);
        const dist = Math.hypot(target[0] - state.x, target[1] - state.z);
        if (dist < p.bestDist - 0.05) {
          p.bestDist = dist;
          p.staleFor = 0;
        } else {
          p.staleFor += dt;
        }
        if (arrived || dist <= arriveR + 0.1) {
          if (p.action.type === "sit" && p.phase === "to-approach") {
            p.phase = "turn";
            return;
          }
          this.settle({ ok: true, status: "arrived", target: p.targetId });
          return;
        }
        if (p.staleFor > 2.5 && state.speed < 0.12) {
          this.settle({
            ok: false,
            status: "blocked",
            target: p.targetId,
            detail: `no progress for 2.5 s, ${dist.toFixed(1)} m out`,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private finishTransition(state: WalkerState, p: Pending): void {
    const s = p.sittable!;
    state.speed = 0;
    state.vx = 0;
    state.vz = 0;
    state.heading = s.facing;
    state.body = s.facing;
    if (p.phase === "down") {
      state.x = s.seat[0];
      state.z = s.seat[1];
      state.y = s.floorY;
      this.posture = "seated";
      this.deps.clips.fire("SittingIdle");
      this.settle({ ok: true, status: "seated", target: s.id });
    } else {
      state.x = s.approach[0];
      state.z = s.approach[1];
      state.y = s.floorY;
      this.posture = "standing";
      this.seatedOn = null;
      this.sitBlend = 0;
      this.deps.clips.fire("Idle");
      this.settle({ ok: true, status: "stood", target: s.id });
    }
  }
}
