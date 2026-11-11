// verseSim.ts — the server-side world: collision, the shared door and prop controllers, and every agent's body.
//
// What GlbWorld.tsx assembles per mounted page (WalkColliders, the Tea House door machine, the InteractController) and what
// ScoutAgent's interval does per tick, with no React and no browser. Pure and IO-free: the host (packages/world-sim/node/loadWorld.ts,
// later apps/sim) fills the collision sets and the world data; this class only simulates.
import { ActorRegistry } from "./actors";
import { AgentBody, SUBSTEP_S, BODY_HEIGHT_M, type AgentBodyDeps } from "./agentBody";
import { BODY_REMY } from "./bodies";
import type { CityNav } from "./cityNav";
import { boxesMesh, createCapsuleWorld } from "./capsuleWorld";
import { InteractController, type InteractableDef } from "./interactables";
import { bearingDeg, type ScoutPlace, type ScoutRoomShape, type Sittable } from "./scout";
import { TEA_BLOCKER_BOX, TeaDoorController, type TeaDoorChannel } from "./teaDoor";
import { WalkColliders } from "./walkColliders";
import type { World } from "./walker";

/** The default door channel: nobody in particular (each body passes its own through `door.drive`). */
const NO_CHANNEL: TeaDoorChannel = { fireDoor: () => false, doorPlaying: false };

export interface VerseData {
  places: ScoutPlace[];
  sittables: Sittable[];
  /** Room footprints and doors, for the scene a body senses (`oracleScene`). */
  rooms?: ScoutRoomShape[];
}

export type AddBodyOpts = Pick<AgentBodyDeps, "spawn"> & { id: string; hipsY?: number };

/** Eye height above the feet, m (sight lines run eye to eye). */
const EYE_M = 1.55;

export class VerseSim {
  /** The walker's collision sets (resident Bazaar, districts, interior furniture boxes, the door blocker). */
  readonly walk = new WalkColliders();
  readonly door: TeaDoorController;
  readonly interact = new InteractController();
  /** Simulation clock, s (advances by whole substeps). */
  t = 0;
  /** Optional baked navmesh handed to every new body as its route planner. */
  nav: CityNav | undefined;
  private data: VerseData = { places: [], sittables: [], rooms: [] };
  private readonly bodies = new Map<string, AgentBody>();
  private readonly staticWorld: World;
  private readonly planningWorld: World;
  /** Mover registry (shares the walk colliders' registry, TTL on the sim clock so a paused sim does not expire bodies). */
  private readonly actors: ActorRegistry;

  constructor() {
    this.actors = new ActorRegistry(2000, () => this.t * 1000);
    this.door = new TeaDoorController({
      channel: NO_CHANNEL,
      selfTick: false, // ticked once per substep by tick()
      setBlocker: (on) => {
        if (on) {
          const m = boxesMesh([TEA_BLOCKER_BOX], [0, 0], "door:tea");
          if (m) this.walk.set("door:tea", [m]);
        } else {
          this.walk.drop("door:tea");
        }
      },
    });
    this.staticWorld = createCapsuleWorld(this.walk.list);
    this.planningWorld = createCapsuleWorld(() => this.walk.listWithout("door:tea"));
  }

  /** The static collision world (no other actors): for spawn search, probes and tests. */
  get world(): World { return this.staticWorld; }

  setData(data: VerseData, interactables: readonly InteractableDef[] = []): void {
    this.data = data;
    this.interact.register(interactables);
  }

  get places(): ScoutPlace[] { return this.data.places; }
  get sittables(): Sittable[] { return this.data.sittables; }
  get rooms(): ScoutRoomShape[] { return this.data.rooms ?? []; }

  /** True once the resident collision is loaded (a body cannot find ground before that). */
  get ready(): boolean { return this.walk.status === "ready"; }

  addBody(opts: AddBodyOpts): AgentBody {
    if (!this.ready) throw new Error("collision not ready");
    if (this.bodies.has(opts.id)) throw new Error(`body ${opts.id} already exists`);
    const body = new AgentBody({
      id: opts.id,
      world: this.actors.wrapWorld(this.staticWorld, opts.id, BODY_HEIGHT_M),
      planningWorld: this.planningWorld,
      nav: this.nav,
      actors: this.actors,
      places: this.data.places,
      sittables: this.data.sittables,
      seatTaken: (seat) => this.seatTakenBy(seat, opts.id),
      rooms: this.data.rooms,
      door: this.door,
      interact: this.interact,
      hipsY: opts.hipsY ?? BODY_REMY.hipsY, // the browser scout's seated-drop body
      spawn: opts.spawn,
      clockMs: () => this.t * 1000,
    });
    this.bodies.set(opts.id, body);
    this.actors.publishWalker(opts.id, body.state, 0.4, BODY_HEIGHT_M, true);
    return body;
  }

  /** Id of the other body holding this seat, or null. */
  seatHolder(seat: string, exceptId?: string): string | null {
    for (const [id, b] of this.bodies) if (id !== exceptId && b.exec.claimedSeatId === seat) return id;
    return null;
  }

  private seatTakenBy(seat: string, selfId: string): boolean { return this.seatHolder(seat, selfId) !== null; }

  /**
   * Other bodies this one can see: within `range`, inside the view cone (always within touch range 2.5 m) and with a clear sight line
   * between eye points. Truth for the senses; callers choose what to reveal.
   */
  visibleBodies(selfId: string, range = 15, halfFovDeg = 65): { id: string; body: AgentBody; distance: number; bearingDeg: number }[] {
    const me = this.bodies.get(selfId);
    if (!me) return [];
    const a = me.state;
    const out: { id: string; body: AgentBody; distance: number; bearingDeg: number }[] = [];
    for (const [id, b] of this.bodies) {
      if (id === selfId) continue;
      const t = b.state;
      const distance = Math.hypot(t.x - a.x, t.z - a.z);
      if (distance > range || Math.abs(t.y - a.y) > 3) continue;
      const bearing = bearingDeg(a.body, t.x - a.x, t.z - a.z);
      if (Math.abs(bearing) > halfFovDeg && distance > 2.5) continue;
      if (this.staticWorld.sightBlocked?.([a.x, a.y + EYE_M, a.z], [t.x, t.y + EYE_M, t.z])) continue;
      out.push({ id, body: b, distance, bearingDeg: bearing });
    }
    return out.sort((x, y) => x.distance - y.distance);
  }

  body(id: string): AgentBody | undefined { return this.bodies.get(id); }

  bodyIds(): string[] { return [...this.bodies.keys()]; }

  removeBody(id: string): void {
    this.bodies.get(id)?.dispose();
    this.bodies.delete(id);
  }

  /** Advance the world by `dt` seconds in substeps of <= 1/30: every body, then the shared controllers, per substep. */
  tick(dt: number): void {
    while (dt > 1e-9) {
      const s = Math.min(dt, SUBSTEP_S);
      for (const b of this.bodies.values()) b.step(s);
      this.door.tick(s);
      this.interact.tick(s);
      this.t += s;
      dt -= s;
    }
  }
}
