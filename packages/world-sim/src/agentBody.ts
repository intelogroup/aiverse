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
import { ScoutExecutor, type Posture, type ScoutAction, type ScoutOutcome, type ScoutPlace, type ScoutRoomShape, type Sittable } from "./scout";
import { clipChannel, type TeaDoorChannel, type TeaDoorController } from "./teaDoor";
import { findSpawn, makeWalker, WALK_CONFIG, type Vec2, type WalkerState, type World } from "./walker";

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

  get busy(): boolean { return this.exec.busy; }

  /** Submit one action. Resolves when it settles (arrived / done / blocked / timeout / rejected ...). */
  act(action: ScoutAction): Promise<ScoutOutcome> {
    return this.exec.submit(action, this.state).then((o) => (o.status === "blocked" ? this.explainBlocked(o) : o));
  }

  /** "No progress" with another body at arm's length is a crowd, not a wall: say so, so the agent waits instead of retrying blind. */
  private explainBlocked(o: ScoutOutcome): ScoutOutcome {
    const s = this.state;
    const near = this.deps.actors.nearby(this.id, [s.x, s.y, s.z], 2.0).length;
    return near ? { ...o, detail: `${o.detail ?? "blocked"}; ${near === 1 ? "another body is" : `${near} other bodies are`} right beside you and may be in the way - wait a few seconds and retry, or pick another spot` } : o;
  }

  /** Advance ONE substep (dt <= SUBSTEP_S): the executor and walker, the mover registry, the one-shot clip clock. */
  step(dt: number): void {
    this.exec.tick(dt, this.state, this.deps.world);
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
      action: this.exec.currentAction?.type ?? null,
      clip: this.clips.current,
      seatedOn: this.exec.seatedSittable?.id ?? null,
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
    this.deps.actors.remove(this.id);
    this.deps.door?.cancel(this.id);
    this.deps.interact?.cancel(this.id);
  }
}
