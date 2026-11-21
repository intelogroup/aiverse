// Fleet — the Bazaar's drivable cars as server bodies. A car is parked until an agent decides to get in (enter_vehicle); walking past one
// does nothing. A driven car steps through vehicle.ts every tick and is judged by the shared signal controller. Cars are first-class
// viewer bodies (a stable roster number, body "car"), so a parked and a driven car are drawn the same way as the resident traffic.
import { FLEET_N0, encodePose, type PoseTuple } from "./streamProtocol";
import { JUNCTIONS, junctionAt, signalState, type Lamp } from "./trafficSignals";
import {
  DISC_OFFSET, DISC_R, axisOfTravel, laneError, laneOffset, makeVehicle, stepVehicle,
  type DriveInput, type Infraction, type TurnPlan, type VehicleState,
} from "./vehicle";
import type { World } from "./walker";
export { MAX_DRIVE_S } from "./actionProtocol";

/** Viewer-stream body numbers: agents count up from 1, resident NPCs start at 1_000_000, cars here. */
export const VEH_N0 = FLEET_N0;
/** Bazaar walking surface: the same y the resident cars use. */
export const VEHICLE_Y = 0.2;
export const ENTER_RANGE_M = 3;
export const SEE_VEHICLE_M = 60;
export const CAR_HEIGHT_M = 1.5;
/** How far ahead (m) the driver can read a signal. */
export const SIGNAL_SIGHT_M = 45;

export interface ParkedSpot { id: string; label: string; x: number; z: number; heading: number }
/** Where the cars start (and the ids the console and the gateway already use). */
export const PARKED: ParkedSpot[] = [
  { id: "car-east", label: "red car", x: 15, z: 5, heading: Math.PI / 2 },
  { id: "car-tea", label: "red car", x: -28, z: -56, heading: 3.0 },
];

export interface Vehicle {
  n: number;
  id: string;
  label: string;
  v: VehicleState;
  /** Agent id of the driver, or null while parked. */
  driver: string | null;
  input: DriveInput;
  /** Simulation time the held input runs out (the car then brakes to a halt: a model thinks for seconds, and a rolling car would not wait). */
  inputUntil: number;
  /** A turn armed with drive {turn}: null otherwise. */
  turn: TurnPlan | null;
  /** Infractions since the driver got in. */
  tally: Record<Infraction["kind"], number>;
}

export interface SignalAhead { distance: number; lamp: Lamp; changesIn: number }

/** Brake applied while no drive command is open (0..1 of full braking). */
export const IDLE_BRAKE = 0.6;
/** Look-ahead (m) of the lane-centring pursuit. */
const LOOKAHEAD_M = 8;
/** How far before a junction an armed turn starts to steer (m). */
const TURN_RUN_UP_M = 5;

const noTally = (): Vehicle["tally"] => ({ red_light: 0, speeding: 0, wrong_lane: 0, collision: 0 });

export class Fleet {
  readonly vehicles: Vehicle[];
  constructor(spots: ParkedSpot[] = PARKED) {
    this.vehicles = spots.map((p, i) => ({
      n: VEH_N0 + i, id: p.id, label: p.label, v: makeVehicle(p.x, VEHICLE_Y, p.z, p.heading),
      driver: null, input: { gas: 0, brake: 0, steer: 0 }, inputUntil: 0, turn: null, tally: noTally(),
    }));
  }

  byId(id: string): Vehicle | undefined { return this.vehicles.find((c) => c.id === id); }
  byDriver(agentId: string): Vehicle | undefined { return this.vehicles.find((c) => c.driver === agentId); }

  nearest(x: number, z: number): { car: Vehicle; distance: number } | null {
    let best: { car: Vehicle; distance: number } | null = null;
    for (const car of this.vehicles) {
      const distance = Math.hypot(car.v.x - x, car.v.z - z);
      if (!best || distance < best.distance) best = { car, distance };
    }
    return best;
  }

  /** Solid footprint, as the resident cars publish: two discs along the length. Ids are `veh:<id>:f|b`. */
  static discIds(car: Pick<Vehicle, "id">): string[] { return [`veh:${car.id}:f`, `veh:${car.id}:b`]; }
  discs(): { id: string; x: number; z: number; r: number; h: number; vx: number; vz: number }[] {
    const out: ReturnType<Fleet["discs"]> = [];
    for (const c of this.vehicles) {
      const s = Math.sin(c.v.heading), k = Math.cos(c.v.heading);
      [DISC_OFFSET, -DISC_OFFSET].forEach((off, i) => out.push({
        id: Fleet.discIds(c)[i], x: c.v.x + s * off, z: c.v.z + k * off, r: DISC_R, h: CAR_HEIGHT_M, vx: s * c.v.speed, vz: k * c.v.speed,
      }));
    }
    return out;
  }

  poses(): PoseTuple[] {
    return this.vehicles.map((c) => encodePose(c.n, { x: c.v.x, z: c.v.z, y: c.v.y, heading: c.v.heading, speed: c.v.speed, posture: "standing", clip: null }));
  }

  roster(): { n: number; agentId: string; body: string }[] {
    return this.vehicles.map((c) => ({ n: c.n, agentId: `npc:veh-${c.id}`, body: "car" }));
  }

  /**
   * Advance every driven car by dt (<= one substep). `worldFor` gives the car's collision world (static geometry plus other actors, minus the
   * car's own discs and its driver). Returns the infractions each driver earned this step.
   */
  step(dt: number, simT: number, now: number, worldFor: (car: Vehicle) => Pick<World, "blocked">): { car: Vehicle; infractions: Infraction[]; blocked: boolean }[] {
    const out: { car: Vehicle; infractions: Infraction[]; blocked: boolean }[] = [];
    for (const c of this.vehicles) {
      if (c.driver === null) continue;
      let input = simT < c.inputUntil ? c.input : { gas: 0, brake: IDLE_BRAKE, steer: 0 };
      if (c.turn && c.turn.phase !== "done") {
        const t = c.turn, h = c.v.heading, here = junctionAt(c.v.x, -c.v.z) !== null;
        // start the corner a few metres before the cell: the car needs the run-up to be round before it leaves it
        const ahead = junctionAt(c.v.x + Math.sin(h) * TURN_RUN_UP_M, -c.v.z - Math.cos(h) * TURN_RUN_UP_M) !== null;
        if (t.phase === "approach" && (here || ahead)) { t.phase = "inside"; t.t0 = simT; }
        else if (t.phase === "inside" && !here && (Math.abs(Math.atan2(Math.sin(t.target - h), Math.cos(t.target - h))) < 0.3 || simT - t.t0 > 10)) t.phase = "done";
      }
      if (c.turn) {
        const t = c.turn;
        input = { ...input, holdHeading: t.phase === "approach" ? t.base : t.target };
        // a car turns tighter slowly: take the corner at 4 m/s at most
        if (t.phase === "inside" && input.holdSpeed !== undefined) input = { ...input, holdSpeed: Math.min(input.holdSpeed, 4) };
      }
      if (input.holdHeading !== undefined) {
        // proportional steering toward the held heading; reversing swaps the sign
        let aim = input.holdHeading;
        // Pure pursuit onto the middle of the lane of the street the held heading runs along (off > 0 is toward the centre line, so aim right).
        // It works inside a junction too, so a held left turn swings the car onto the new street's lane instead of wide of it.
        const axisErr = Math.abs(Math.atan2(Math.sin(aim * 4), Math.cos(aim * 4))) / 4;   // distance of the held heading from the nearest street axis
        const off = input.reverse || axisErr > 0.2 ? null : laneOffset(c.v.x, -c.v.z, aim, true);
        if (off !== null) aim -= Math.max(-0.8, Math.min(0.8, Math.atan(off / LOOKAHEAD_M)));
        const err = Math.atan2(Math.sin(aim - c.v.heading), Math.cos(aim - c.v.heading));
        input = { ...input, steer: Math.max(-1, Math.min(1, err * 2.5 * (input.reverse ? -1 : 1))) };
      }
      if (input.holdSpeed !== undefined && !input.reverse) {
        const e = input.holdSpeed - c.v.speed;
        input = { ...input, gas: e > 0.05 ? Math.min(1, e / 1) : 0, brake: e < -0.4 ? Math.min(1, -e / 2) : 0 };
      }
      const r = stepVehicle(c.v, input, dt, worldFor(c), now);
      for (const i of r.infractions) c.tally[i.kind]++;
      if (r.infractions.length || r.blocked) out.push({ car: c, infractions: r.infractions, blocked: r.blocked });
    }
    return out;
  }

  /** What the driver can read off the road ahead: the next signal on the line of travel and the lateral lane error. */
  static senses(car: Vehicle, now: number): { signal: SignalAhead | null; laneErrorM: number | null; junction: boolean } {
    const v = car.v, px = v.x, py = -v.z, dx = Math.sin(v.heading), dy = -Math.cos(v.heading);
    const inside = junctionAt(px, py);
    let signal: SignalAhead | null = null;
    if (!inside) {
      for (let d = 1; d <= SIGNAL_SIGHT_M; d += 1) {
        const j = junctionAt(px + dx * d, py + dy * d);
        if (!j) continue;
        const s = signalState(JUNCTIONS[j.id], now), axis = axisOfTravel(dx, dy);
        signal = { distance: d, lamp: s[axis], changesIn: Math.round(s.changesIn * 10) / 10 };
        break;
      }
    }
    return { signal, laneErrorM: laneError(px, py, v.heading), junction: inside !== null };
  }
}
