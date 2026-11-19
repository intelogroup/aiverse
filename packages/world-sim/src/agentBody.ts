// agentBody.ts — one agent's body with no browser: the part of ScoutAgent.tsx that is not React.
//
// ScoutAgent (the console's browser scout) owns a WalkerState, a ScoutExecutor and a ClipTestState, builds the executor's
// dependencies (route planner, avoidance, door and prop hooks) and steps it on a clock. This class is exactly that, minus the
// figure, camera and vision: the server sim holds one per agent and the console only renders what it publishes.
//
// Contract with the host (VerseSim): `step(dt)` advances ONE substep (dt <= 1/30, the walker's tuned step); the host ticks the
// shared door and prop controllers once per substep itself (they are per world, not per body).
import { ActorRegistry, avoidActorInput, type ActorBody } from "./actors";
import { CityNav } from "./cityNav";
import { ClipTestState } from "./clips";
import type { InteractController } from "./interactables";
import { navigationSegment, planRoute } from "./navigation";
import { ScoutExecutor, type Gaze, type Posture, type ScoutAction, type ScoutOutcome, type ScoutPlace, type ScoutRoomShape, type Sittable } from "./scout";
import { clipChannel, type TeaDoorChannel, type TeaDoorController } from "./teaDoor";
import { inTeaBuilding, TEA_FLOORS, teaFloorAt } from "./teaBuilding";
import { LIFT, type TeaElevatorController } from "./teaElevator";
import { FLOOR_IDS } from "./teaLandmarks";
import { findSpawn, makeWalker, step, WALK_CONFIG, type Vec2, type WalkerState, type World } from "./walker";

/** Substep ceiling: walker.step is tuned at 1/30 s (ScoutAgent's sim driver uses the same). */
export const SUBSTEP_S = 1 / 30;
/** Body height the avoidance and the actor registry assume (CastFigure's realistic adults, m). */
export const BODY_HEIGHT_M = 1.7;
/** Avoidance sees movers within this range, in front of the body (half-angle PI / 4), as ScoutAgent's `visibleMovers` does. */
const AVOID_RANGE = 10;
const AVOID_HALF_FOV = Math.PI / 4;
/** Planner options of ScoutAgent's `plan` / `safe` deps. */
/** A Detour corridor may stop this far (XZ, m) from the goal and still count as reached (inside every interaction radius). */
const NAV_END_GAP_M = 1.0;
const NAV = { halfExtent: 128, cellSize: 1, maxExpansions: 10000 };
const ELEVATOR_APPROACH_Z = LIFT.doorZ + 1.29;
const ELEVATOR_CLEAR_Z = LIFT.doorZ + .89;
const ELEVATOR_BOARD_Z = LIFT.front - .68;
const ELEVATOR_CABIN_Z = (LIFT.front + LIFT.back) / 2;
/** Action types that move the body: their blocked outcomes carry proprioception evidence (blockedBy / blockedAfterMs). */
const MOVEMENT_TYPES: ReadonlySet<ScoutAction["type"]> = new Set(["go_to", "run_to", "enter"]);
/** blockedBy names a published place or seat only within this distance of the obstruction (m); farther, the field is omitted. */
const BLOCKED_BY_RANGE_M = 5;

export interface AgentBodyDeps {
  id: string;
  /** The world the body steps in: the host's collision world wrapped so other actors block (`ActorRegistry.wrapWorld`). */
  world: World;
  /** Same geometry without the closed-door blocker, for route planning (the door machine opens it on the way). */
  planningWorld: World;
  /** Baked navmesh (Detour). When present it plans every route; otherwise the grid A* (`planRoute`) does. */
  nav?: CityNav;
  actors: ActorRegistry;
  places: ScoutPlace[];
  sittables: Sittable[];
  seatTaken?: (id: string) => boolean;
  rooms?: ScoutRoomShape[];
  door?: TeaDoorController;
  interact?: InteractController;
  elevator?: TeaElevatorController;
  /** Hips height for the seated drop (bodies.ts BODY_REMY.hipsY in the browser scout). */
  hipsY: number;
  /** Where to appear: free standing spot near (x, z) within maxR (default 3 m). Omitted: the plaza spawn search. */
  spawn?: { x: number; z: number; heading?: number; maxR?: number };
  /** Millisecond clock for actor-registry timestamps (the host passes its simulation clock so runs are deterministic). */
  clockMs: () => number;
}

export interface AgentSnapshot {
  id: string;
  /** Executor clock, s since the body was created. */
  t: number;
  x: number;
  y: number;
  z: number;
  /** Body (figure) heading, rad, walker convention (faces (sin h, cos h)). */
  heading: number;
  speed: number;
  posture: Posture;
  /** The action in flight, or null when idle. */
  action: ScoutAction["type"] | null;
  /** The clip the figure should be playing (one-shots: sit, door, interact, social), or null for locomotion. */
  clip: string | null;
  seatedOn: string | null;
  /** Head direction relative to the body, degrees (yaw + right, pitch + up); look and see follow it. */
  gaze: Gaze;
}

/** What a viewer needs to draw the figure this instant (the console's AgentFrame, plus height and clip). */
export interface AgentPose {
  x: number;
  z: number;
  /** Height of the figure group: the walker's y, or the seat override's. */
  y: number;
  heading: number;
  speed: number;
  posture: Posture;
  clip: string | null;
}

export class AgentBody {
  readonly id: string;
  readonly state: WalkerState;
  readonly exec: ScoutExecutor;
  /** The body's clip channel: the executor fires sit / door / interact / social clips through it; step() expires one-shots. */
  readonly clips = new ClipTestState();
  private readonly deps: AgentBodyDeps;
  private readonly channel: TeaDoorChannel;
  private ride?: {
    action: Extract<ScoutAction, { type: "ride_elevator" }>;
    from: number;
    to: number;
    phase: "approach" | "wait" | "board" | "travel" | "exit";
    remaining: number;
    resolve: (result: ScoutOutcome) => void;
  };

  constructor(deps: AgentBodyDeps) {
    this.deps = deps;
    this.id = deps.id;
    this.channel = clipChannel(this.clips);
    const sp = findSpawn(deps.world, deps.spawn ? { cx: deps.spawn.x, cz: deps.spawn.z, maxR: deps.spawn.maxR ?? 3 } : undefined);
    if (!sp) throw new Error(`no free spawn near ${deps.spawn ? `(${deps.spawn.x}, ${deps.spawn.z})` : "the plaza"}`);
    this.state = makeWalker(sp.x, sp.y, sp.z, deps.spawn?.heading ?? 0);
    const { door, interact } = deps;
    this.exec = new ScoutExecutor({
      places: deps.places,
      sittables: deps.sittables,
      seatTaken: deps.seatTaken,
      rooms: deps.rooms,
      cancel: () => { door?.cancel(this.id); interact?.cancel(this.id); },
      plan: (s, target) => {
        const y = deps.planningWorld.groundY(target[0], target[1], s.y + WALK_CONFIG.stepUp + 0.05);
        if (y === null) return null;
        if (deps.nav) {
          const r = deps.nav.route({ x: s.x, y: s.y, z: s.z }, { x: target[0], y, z: target[1] });
          // A corridor that ends short of the goal is a failed plan here (the grid planner's "found" means it reached the goal).
          return r && r.endGap <= NAV_END_GAP_M ? r.waypoints.slice(1).map((p): Vec2 => [p.x, p.z]) : null;
        }
        const route = planRoute(deps.planningWorld, [s.x, s.y, s.z], [target[0], y, target[1]], NAV);
        return route.status === "found" ? route.waypoints.slice(1).map((p): Vec2 => [p[0], p[2]]) : null;
      },
      // The grid planner's segment test is stricter than Detour's string-pulled corners (it rejected a route Detour had just
      // planned, "route repeatedly obstructed"); a navmesh route is already walkable, and the stall detector replans a snag.
      safe: deps.nav ? undefined : (s, target) => {
        const y = deps.planningWorld.groundY(target[0], target[1], s.y + WALK_CONFIG.stepUp + 0.05);
        return y !== null && navigationSegment(deps.planningWorld, [s.x, s.y, s.z], [target[0], y, target[1]]);
      },
      avoid: (s, wanted) => {
        const self: ActorBody = {
          id: this.id,
          position: [s.x, s.y, s.z],
          velocity: [Math.sin(s.heading) * wanted.forward * 1.3, Math.cos(s.heading) * wanted.forward * 1.3],
          radius: WALK_CONFIG.radius,
          height: BODY_HEIGHT_M,
          updatedAtMs: deps.clockMs(),
        };
        return avoidActorInput(self, this.visibleMovers(), wanted);
      },
      clips: this.clips,
      hipsY: deps.hipsY,
      door: door ? (s, wanted, dt) => door.drive(s, dt, wanted.forward > 0, this.id, this.channel) : undefined,
      interact: interact
        ? {
            defs: () => interact.list(),
            isOn: (id) => interact.isOn(id),
            request: (id, at) => interact.request(id, this.id, this.clips, at),
            drive: (s, dt) => interact.drive(s, dt, this.id),
          }
        : undefined,
    });
  }

  /**
   * Movers in front of the body within range. The browser scout also drops the ones hidden behind a wall (a raycast against the
   * collision meshes); the headless body does not yet, so it may yield to someone it could not see through a wall. Known gap.
   */
  private visibleMovers(): ActorBody[] {
    const s = this.state;
    return this.deps.actors.nearby(this.id, [s.x, s.y, s.z], AVOID_RANGE).filter((b) => {
      const bearing = Math.atan2(b.position[0] - s.x, b.position[2] - s.z) - s.body;
      return Math.abs(Math.atan2(Math.sin(bearing), Math.cos(bearing))) <= AVOID_HALF_FOV;
    });
  }

  get busy(): boolean { return this.exec.busy || this.ride !== undefined; }

  /** Submit one action. Resolves when it settles (arrived / done / blocked / timeout / rejected ...). */
  act(action: ScoutAction): Promise<ScoutOutcome> {
    if (action.type === "ride_elevator") return this.startRide(action);
    if (this.ride) {
      if (action.type !== "stop") return Promise.resolve({ ok: false, status: "rejected", detail: "busy" });
      if (this.ride.phase !== "approach" && this.ride.phase !== "wait") {
        return Promise.resolve({ ok: false, status: "rejected", detail: "Wait until you are clear of the elevator" });
      }
      this.finishRide({ ok: false, status: "blocked", detail: "Elevator ride canceled" });
    }
    if (action.type === "interact") {
      const prop = this.deps.interact?.list().find((d) =>
        d.id === action.target || d.kind === action.target || d.label.toLowerCase() === action.target.toLowerCase());
      if (prop?.kind === "egg" && Math.abs(this.state.y - prop.floorY) > 1.6) {
        return Promise.resolve({ ok: false, status: "unavailable", detail: "The egg is on a different floor", target: prop.id });
      }
    }
    const t0 = this.exec.t;
    return this.exec.submit(action, this.state).then((o) => {
      if (o.status !== "blocked") return o;
      const explained = this.explainBlocked(o);
      return MOVEMENT_TYPES.has(action.type) ? this.blockedEvidence(action, explained, t0) : explained;
    });
  }

  private startRide(action: Extract<ScoutAction, { type: "ride_elevator" }>): Promise<ScoutOutcome> {
    const lift = this.deps.elevator;
    const s = this.state;
    const from = teaFloorAt(s.y);
    const to = FLOOR_IDS.indexOf(action.floor);
    if (this.busy) return Promise.resolve({ ok: false, status: "rejected", detail: "busy" });
    if (!lift?.ready || !inTeaBuilding(s.x, s.z) || Math.abs(s.y - TEA_FLOORS[from]!.y) > .3 ||
        action.target !== `tea-${FLOOR_IDS[from]}-elevator` || to === from || to < 0 || this.exec.posture !== "standing") {
      return Promise.resolve({ ok: false, status: "unavailable", detail: "Use a visible elevator marker on your current floor and choose a different floor" });
    }
    if (!lift.reserveRide(s)) return Promise.resolve({ ok: false, status: "blocked", detail: "Elevator is serving another agent. Try again after it arrives." });
    return new Promise((resolve) => {
      this.ride = { action, from, to, phase: "approach", remaining: 90, resolve };
      const ride = this.ride;
      void this.exec.submit({ type: "go_to", point: [LIFT.x, ELEVATOR_APPROACH_Z] }, s).then((result) => {
        if (this.ride !== ride) return;
        if (!result.ok || lift.access(s) !== from || !lift.call(from)) {
          this.finishRide({ ok: false, status: "blocked", detail: "Could not approach or call the elevator" });
          return;
        }
        ride.phase = "wait";
      });
    });
  }

  private finishRide(result: ScoutOutcome): void {
    const ride = this.ride!;
    this.ride = undefined;
    this.deps.elevator?.releaseRide(this.state);
    ride.resolve({ ...result, target: ride.action.target });
  }

  private stepRide(dt: number): void {
    const lift = this.deps.elevator!;
    const ride = this.ride!;
    const s = this.state;
    const idle = { forward: 0, strafe: 0, turn: 0, run: false };
    ride.remaining -= dt;
    if (ride.remaining <= 0 || lift.phase === "unavailable") {
      this.finishRide({ ok: false, status: "blocked", detail: "Elevator ride could not reach the requested landing" });
      step(s, idle, dt, this.deps.world);
      return;
    }
    if (ride.phase === "wait" && lift.canPass(ride.from)) ride.phase = "board";
    if (ride.phase === "travel" && lift.canPass(ride.to)) ride.phase = "exit";
    if (ride.phase === "board" && lift.access(s) === "cabin" && s.z <= ELEVATOR_BOARD_Z) {
      ride.phase = "travel";
      if (!lift.call(ride.to)) {
        this.finishRide({ ok: false, status: "blocked", detail: "Elevator refused the destination" });
      }
    } else if (ride.phase === "exit" && s.z >= ELEVATOR_CLEAR_Z && Math.abs(s.y - TEA_FLOORS[ride.to]!.y) <= .2) {
      this.finishRide({ ok: true, status: "arrived", detail: `Exited elevator on ${ride.action.floor}` });
    }
    const moving = this.ride && (ride.phase === "board" || ride.phase === "exit");
    const targetZ = ride.phase === "board" ? ELEVATOR_CABIN_Z : ELEVATOR_APPROACH_Z;
    const dx = LIFT.x - s.x;
    // Center the capsule before crossing the narrow sill, then keep it centered.
    const facing = Math.atan2(dx * 5, targetZ - s.z);
    step(s, moving ? {
      ...idle, forward: 0.55, faceHeading: facing,
    } : idle, dt, this.deps.world);
  }

  /**
   * Proprioception for a blocked movement act: how long the attempt ran, and the nearest published place or seat to the
   * obstruction. The anchor is the destination when no route could be planned (the body never moved; the block is at the
   * target) and the body's final position otherwise (it stopped where it was stopped). Ids only — places and seats are
   * published (map / observe scene), so naming one leaks nothing unpublished.
   */
  private blockedEvidence(action: ScoutAction, o: ScoutOutcome, t0: number): ScoutOutcome {
    const anchor = o.detail === "no safe route" ? (this.actionTarget(action) ?? [this.state.x, this.state.z]) : [this.state.x, this.state.z];
    let best: string | undefined;
    let bestD = BLOCKED_BY_RANGE_M;
    for (const p of this.deps.places) {
      const d = Math.hypot(p.pos[0] - anchor[0], p.pos[1] - anchor[1]);
      if (d <= bestD) { bestD = d; best = p.id; }
    }
    for (const s of this.deps.sittables) {
      const d = Math.hypot(s.seat[0] - anchor[0], s.seat[1] - anchor[1]);
      if (d <= bestD) { bestD = d; best = s.id; }
    }
    return { ...o, blockedAfterMs: Math.round((this.exec.t - t0) * 1000), ...(best ? { blockedBy: best } : {}) };
  }

  /** Where a movement action was headed, as a point: its point, or its place's stand point. */
  private actionTarget(action: ScoutAction): Vec2 | null {
    if (action.type !== "go_to" && action.type !== "run_to" && action.type !== "enter") return null;
    if (action.type !== "enter" && action.point) return action.point;
    if (action.place) {
      const p = this.deps.places.find((pl) => pl.id === action.place);
      if (p) return p.stand;
    }
    return null;
  }

  /**
   * "No progress" with another body at arm's length is a crowd, not a wall: say so, so the agent waits instead of retrying blind.
   * Only for a stall on the way (no progress, route repeatedly obstructed): "no safe route" and "could not start" are
   * planning refusals that a body standing nearby did not cause, and waiting would not fix them.
   */
  private explainBlocked(o: ScoutOutcome): ScoutOutcome {
    if (!/^(no progress|route repeatedly obstructed)/.test(o.detail ?? "")) return o;
    const s = this.state;
    const near = this.deps.actors.nearby(this.id, [s.x, s.y, s.z], 2.0).length;
    return near ? { ...o, detail: `${o.detail ?? "blocked"}; ${near === 1 ? "another body is" : `${near} other bodies are`} right beside you and may be in the way - wait a few seconds and retry, or pick another spot` } : o;
  }

  /** Advance ONE substep (dt <= SUBSTEP_S): the executor and walker, the mover registry, the one-shot clip clock. */
  step(dt: number): void {
    if (this.ride && this.ride.phase !== "approach") this.stepRide(dt);
    else this.exec.tick(dt, this.state, this.deps.world);
    const a = this.exec.currentAction;
    this.deps.actors.publishWalker(this.id, this.state, WALK_CONFIG.radius, BODY_HEIGHT_M, true, a?.type === "play" && this.clips.current === a.clip ? a.clip : undefined);
    this.clips.tick(dt);
  }

  snapshot(): AgentSnapshot {
    const s = this.state;
    return {
      id: this.id,
      t: this.exec.t,
      x: s.x, y: s.y, z: s.z,
      heading: s.body,
      speed: s.speed,
      posture: this.exec.posture,
      action: this.ride?.action.type ?? this.exec.currentAction?.type ?? null,
      clip: this.clips.current,
      seatedOn: this.exec.seatedSittable?.id ?? null,
      gaze: { ...this.exec.gaze },
    };
  }

  /** The pose a viewer draws: the walker's, or the executor's seat override while sitting (as ScoutAgent's frame loop does). */
  pose(): AgentPose {
    const s = this.state;
    const ov = this.exec.frameOverride();
    return {
      x: ov ? ov.x : s.x,
      z: ov ? ov.z : s.z,
      y: ov ? ov.y + ov.drop : s.y,
      heading: ov ? ov.heading : s.body,
      speed: ov ? 0 : s.speed,
      posture: this.exec.posture,
      clip: this.clips.current,
    };
  }

  /** Forget this body's registry entry (agent left the world). */
  dispose(): void {
    if (this.ride) this.finishRide({ ok: false, status: "blocked", detail: "Body left the world" });
    this.deps.actors.remove(this.id);
    this.deps.door?.cancel(this.id);
    this.deps.interact?.cancel(this.id);
  }
}
