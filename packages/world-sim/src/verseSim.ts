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
import type { ScoutPlace, Sittable } from "./scout";
import { TEA_BLOCKER_BOX, TeaDoorController, type TeaDoorChannel } from "./teaDoor";
import { WalkColliders } from "./walkColliders";
import type { World } from "./walker";

/** The default door channel: nobody in particular (each body passes its own through `door.drive`). */
const NO_CHANNEL: TeaDoorChannel = { fireDoor: () => false, doorPlaying: false };

export interface VerseData {
  places: ScoutPlace[];
  sittables: Sittable[];
}

export type AddBodyOpts = Pick<AgentBodyDeps, "spawn"> & { id: string; hipsY?: number };

export class VerseSim {
  /** The walker's collision sets (resident Bazaar, districts, interior furniture boxes, the door blocker). */
  readonly walk = new WalkColliders();
  readonly door: TeaDoorController;
  readonly interact = new InteractController();
  /** Simulation clock, s (advances by whole substeps). */
  t = 0;
  /** Optional baked navmesh handed to every new body as its route planner. */
  nav: CityNav | undefined;
  private data: VerseData = { places: [], sittables: [] };
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
