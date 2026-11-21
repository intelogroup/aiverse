// Drivable vehicle (pure: no IO, no three). A kinematic bicycle model plus the rules of the road, so a body that drives a Bazaar car
// is judged by the same signal controller every viewer sees (trafficSignals.ts, a function of the wall clock).
//
// Frames: world x/z with heading h facing (sin h, cos h) (walker.ts). Plan coords (signals, street geometry) are x east, y = -z north.
// Steering: +1 = LEFT (heading increases), -1 = right, like the lab's turn_left/turn_right. Positions are the car's centre.
import type { Hit, Vec3, World } from "./walker";
import { JUNCTIONS, STREETS, signalState, junctionAt, type Axis } from "./trafficSignals";

export const WHEELBASE = 2.8;          // m (the lab's DRIVER.wheelbase)
export const HALF_LENGTH = 2.45;
export const DISC_R = 1.1, DISC_OFFSET = 1.2;   // the footprint is two discs, like the resident cars (ambientWorld.discs)
export const V_MAX = 15;               // m/s, what the car can do
export const V_REV = 3;                // m/s, the most it reverses at
export const V_LIMIT = 11.5;           // m/s, about 25 mph (the signal progression speed): above this for SPEED_GRACE_S is a speeding event
export const SPEED_GRACE_S = 1;
export const ACCEL = 2.5, BRAKE = 6, COAST = 1.2;   // m/s^2 (gas at full, brake at full, engine drag with no input)
export const MAX_STEER = 0.5;          // rad at the wheels
export const STEER_RATE = 2.2;         // rad/s the wheels move to the wanted angle
export const WRONG_LANE_S = 2;         // on the wrong side of the street this long before it counts
export const WRONG_LANE_M = 0.5;       // wrong side by at least this much

export interface VehicleState {
  x: number; y: number; z: number;
  heading: number;
  speed: number;     // m/s, negative while reversing
  steer: number;     // wheel angle, rad
  /** Seconds the car has been on the wrong side of the street / over the limit (for the one-event-per-excursion rules). */
  wrongLaneS: number; overLimitS: number;
  /** The junction rect id the car is inside (null outside): a red-light run counts once, on entry. */
  inJunction: number | null;
  /** The wrong-lane / speeding excursion already reported (re-armed when the car comes right). */
  reportedWrongLane: boolean; reportedSpeeding: boolean;
}

/** What the driver is asking for right now. gas/brake 0..1, steer -1..1 (+ left). */
export interface DriveInput { gas: number; brake: number; steer: number; /** Gas drives the car backwards (slowly) instead of forwards. */ reverse?: boolean; /** World heading (radians) to hold: the steering is computed each step and `steer` is ignored. */ holdHeading?: number; /** Speed (m/s) to hold: gas and brake are computed each step and ignored. */ holdSpeed?: number }

export type InfractionKind = "red_light" | "speeding" | "wrong_lane" | "collision";
export interface Infraction { kind: InfractionKind; detail: string }

export function makeVehicle(x: number, y: number, z: number, heading = 0): VehicleState {
  return { x, y, z, heading, speed: 0, steer: 0, wrongLaneS: 0, overLimitS: 0, inJunction: null, reportedWrongLane: false, reportedSpeeding: false };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Plan position and heading direction of a vehicle: plan y = -z, so the plan direction of world (sin h, cos h) is (sin h, -cos h). */
const planDir = (h: number): [number, number] => [Math.sin(h), -Math.cos(h)];

/** Which signal phase governs travel in this plan direction: east-west traffic follows "ew", north-south "ns". */
export function axisOfTravel(dx: number, dy: number): Axis { return Math.abs(dx) >= Math.abs(dy) ? "ew" : "ns"; }

/**
 * The side of the street the car should be on, relative to the street centre line, for right-hand traffic.
 * Returns the signed lateral error in metres (positive = on the wrong side) or null off any street / inside a junction.
 */
export function laneError(planX: number, planY: number, heading: number): number | null {
  return laneInfo(planX, planY, heading)?.err ?? null;
}

/** laneError plus the street's width, so a lane keeper knows where the middle of the lane is (w/4 inside the centre line). */
function laneInfo(planX: number, planY: number, heading: number): { err: number; w: number } | null {
  if (junctionAt(planX, planY)) return null;
  const [dx, dy] = planDir(heading);
  if (Math.abs(dx) >= Math.abs(dy)) {            // along x: an east-west street at y = c
    const s = STREETS.find((q) => Math.abs(planY - q.c) <= q.w / 2);
    if (!s) return null;
    // east (+x) keeps to the south (y < c); west keeps north. error > 0 when on the other side.
    return { err: dx > 0 ? planY - s.c : s.c - planY, w: s.w };
  }
  const s = STREETS.find((q) => Math.abs(planX - q.c) <= q.w / 2);   // along y: a north-south street at x = c
  if (!s) return null;
  // north (+y) keeps to the east (x > c); south keeps west.
  return { err: dy > 0 ? s.c - planX : planX - s.c, w: s.w };
}

/**
 * Metres from the middle of the lane the car is in: positive when it sits toward the centre line (left of the lane middle), negative when
 * toward the kerb. null in a junction or off a street. Lets a heading-holder keep the lane without the driver steering.
 */
export function laneOffset(planX: number, planY: number, heading: number): number | null {
  const i = laneInfo(planX, planY, heading);
  return i ? i.err + i.w / 4 : null;
}

export interface StepResult { moved: number; infractions: Infraction[]; /** Pushed against something this step (even too slowly to count as a collision). */ blocked: boolean }

/**
 * Advance one vehicle by dt (s). `world.blocked` (the wrapped world of the body, so other bodies and NPC discs count too) is asked about both
 * footprint discs; a hit cancels the move, stops the car and reports one collision. `now` (s, wall clock) feeds the signal controller.
 */
export function stepVehicle(v: VehicleState, input: DriveInput, dt: number, world: Pick<World, "blocked">, now: number): StepResult {
  const infractions: Infraction[] = [];
  const gas = clamp(input.gas, 0, 1), brake = clamp(input.brake, 0, 1), steerIn = clamp(input.steer, -1, 1);
  // wheels follow the wanted angle at a limited rate; less lock at speed (a 5 m/s car does not whip round at full lock)
  const lock = MAX_STEER / (1 + (v.speed / 8) ** 2);
  const want = steerIn * lock;
  v.steer += clamp(want - v.steer, -STEER_RATE * dt, STEER_RATE * dt);
  // Speed is signed. Brake and engine drag always pull it toward zero; gas pushes toward the chosen direction, braking first when the car
  // still rolls the other way. Nothing crosses zero on its own: a car that brakes to a halt stays halted.
  const sign = v.speed > 0 ? 1 : v.speed < 0 ? -1 : 0, dir = input.reverse ? -1 : 1;
  let nextSpeed: number;
  if (brake > 0) nextSpeed = v.speed - sign * Math.min(Math.abs(v.speed), BRAKE * brake * dt);
  else if (gas > 0 && (sign === 0 || sign === dir)) nextSpeed = clamp(v.speed + dir * ACCEL * gas * dt, -V_REV, V_MAX);
  else if (gas > 0) nextSpeed = v.speed - sign * Math.min(Math.abs(v.speed), BRAKE * dt);
  else nextSpeed = v.speed - sign * Math.min(Math.abs(v.speed), COAST * dt);
  const dist = (v.speed + nextSpeed) / 2 * dt;
  const yaw = dist / WHEELBASE * Math.tan(v.steer);
  const h2 = v.heading + yaw;
  const hm = v.heading + yaw / 2;
  const nx = v.x + Math.sin(hm) * dist, nz = v.z + Math.cos(hm) * dist;

  // Footprint check: both discs at the new pose, each coming from where it was.
  let hit: Hit | null = null;
  if (Math.abs(dist) > 1e-6) {
    for (const off of [DISC_OFFSET, -DISC_OFFSET]) {
      const from: Vec3 = [v.x + Math.sin(v.heading) * off, v.y, v.z + Math.cos(v.heading) * off];
      const to: Vec3 = [nx + Math.sin(h2) * off, v.y, nz + Math.cos(h2) * off];
      hit = world.blocked(from, to, DISC_R);
      // A car resting against a wall still overlaps it by a hair, so the probe reports a hit for any move. Only a move INTO the surface
      // (against its outward normal) blocks; moving away, which is how a stuck car backs out, is free.
      if (hit && hit.nx * (to[0] - from[0]) + hit.nz * (to[2] - from[2]) > -1e-6) hit = null;
      if (hit) break;
    }
  }
  if (hit) {
    if (Math.abs(v.speed) > 0.5) infractions.push({ kind: "collision", detail: `hit something at ${v.speed.toFixed(1)} m/s` });
    v.speed = 0;
    return { moved: 0, infractions, blocked: true };
  }
  const px0 = v.x, pz0 = v.z;
  v.x = nx; v.z = nz; v.heading = h2; v.speed = nextSpeed;

  // Rules of the road, judged on plan coordinates.
  const planX = v.x, planY = -v.z;
  const [dx, dy] = planDir(v.heading);
  const j = junctionAt(planX, planY);
  const jid = j ? j.id : null;
  if (jid !== null && v.inJunction !== jid) {            // entered a junction this step
    const lamp = signalState(JUNCTIONS[jid], now)[axisOfTravel(dx, dy)];
    if (lamp === "red") infractions.push({ kind: "red_light", detail: `entered junction ${jid} on red` });
  }
  v.inJunction = jid;

  if (v.speed > V_LIMIT) { v.overLimitS += dt; if (v.overLimitS >= SPEED_GRACE_S && !v.reportedSpeeding) { v.reportedSpeeding = true; infractions.push({ kind: "speeding", detail: `${v.speed.toFixed(1)} m/s, limit ${V_LIMIT}` }); } }
  else { v.overLimitS = 0; v.reportedSpeeding = false; }

  const err = Math.abs(v.speed) > 0.5 ? laneError(planX, planY, v.heading) : null;
  if (err !== null && err > WRONG_LANE_M) { v.wrongLaneS += dt; if (v.wrongLaneS >= WRONG_LANE_S && !v.reportedWrongLane) { v.reportedWrongLane = true; infractions.push({ kind: "wrong_lane", detail: `${err.toFixed(1)} m on the wrong side` }); } }
  else { v.wrongLaneS = 0; v.reportedWrongLane = false; }

  return { moved: Math.hypot(v.x - px0, v.z - pz0), infractions, blocked: false };
}
