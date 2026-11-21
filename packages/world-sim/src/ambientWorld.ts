// AmbientWorld — the Bazaar's resident cars and pedestrians as server bodies, so every viewer sees the same ones.
// It wraps the pure sim in ambientTraffic.ts, steps with the world tick, reads the shared signal controller on the wall clock, and
// publishes poses and roster rows in the same wire format as agent bodies (streamProtocol.ts). NPC body numbers start at
// NPC_N0, far above the agent numbers (which count up from 1), and the roster body ids are "car" and a cast body id.
import type { AgentPose } from "./agentBody";
import { PED_SPEED, sample, type Obstacle, spawnCars, spawnWalkers, stepCars, stepWalkers, type Car, type Walker } from "./ambientTraffic";
import { encodePose, type PoseTuple } from "./streamProtocol";

export const NPC_N0 = 1_000_000;
/** Bazaar walking surface (plan.json walk_z): NPC y is this; the console adds the car's wheel offset itself. */
export const NPC_GROUND_Y = 0.2;
export const CAR_BODY = "car";
export const PEDESTRIAN_BODY = "business";

export class AmbientWorld {
  readonly cars: Car[];
  readonly walkers: Walker[];
  constructor(private readonly nowS: () => number = () => Date.now() / 1000, perLoop = 2) {
    this.cars = spawnCars(perLoop);
    this.walkers = spawnWalkers();
    stepWalkers(this.walkers, 0, this.nowS());   // place them before the first frame
  }

  /** `bodies`: agent bodies in world x/z (z = -plan y); a car holds for one in its lane (ambientTraffic.gapToBody). */
  step(dt: number, bodies: readonly { x: number; z: number }[] = []): void {
    const now = this.nowS();
    const obstacles: Obstacle[] = bodies.map((b) => ({ x: b.x, y: -b.z, r: 0.4 }));
    stepCars(this.cars, dt, now, obstacles);
    stepWalkers(this.walkers, dt, now);
  }

  /** Plan (x east, y north) -> the world's x/z (z = -y). Headings are three headings: 0 faces +z. */
  poses(): PoseTuple[] {
    const out: PoseTuple[] = [];
    this.cars.forEach((c, i) => {
      const p = sample(c.loop, c.s);
      const pose: AgentPose = { x: p.x, z: -p.y, y: NPC_GROUND_Y, heading: Math.atan2(p.dx, -p.dy), speed: c.v, posture: "standing", clip: null };
      out.push(encodePose(NPC_N0 + i, pose));
    });
    this.walkers.forEach((w, i) => {
      const pose: AgentPose = { x: w.x, z: -w.y, y: NPC_GROUND_Y, heading: w.heading, speed: w.moving ? PED_SPEED : 0, posture: "standing", clip: null };
      out.push(encodePose(NPC_N0 + 1000 + i, pose));
    });
    return out;
  }

  /** Solid footprint for agent bodies: a car is two discs along its length, a pedestrian one. Ids are stable per NPC. */
  discs(): { id: string; x: number; z: number; r: number; h: number; vx: number; vz: number }[] {
    const out: { id: string; x: number; z: number; r: number; h: number; vx: number; vz: number }[] = [];
    this.cars.forEach((c, i) => {
      const p = sample(c.loop, c.s);
      const dx = p.dx, dz = -p.dy;
      for (const [k, off] of [["f", 1.2], ["b", -1.2]] as const) out.push({ id: `npc:car-${i}${k}`, x: p.x + dx * off, z: -p.y + dz * off, r: 1.1, h: 1.5, vx: dx * c.v, vz: dz * c.v });
    });
    this.walkers.forEach((w, i) => out.push({ id: `npc:ped-${i}`, x: w.x, z: -w.y, r: 0.35, h: 1.8, vx: 0, vz: 0 }));
    return out;
  }

  /** `agentId` is a label the gateway never looks up: it starts with "npc:". */
  roster(): { n: number; agentId: string; body: string }[] {
    return [
      ...this.cars.map((_, i) => ({ n: NPC_N0 + i, agentId: `npc:car-${i}`, body: CAR_BODY })),
      ...this.walkers.map((_, i) => ({ n: NPC_N0 + 1000 + i, agentId: `npc:ped-${i}`, body: PEDESTRIAN_BODY })),
    ];
  }
}
