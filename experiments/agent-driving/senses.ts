// The car's instruments for an agent that cannot read a camera frame at speed: a short, time-stamped
// list built like a sensor, not an oracle. Range and field of view are limited, a light is readable only
// near, and a side shows a blind-spot flag, not the car's identity. Geometry is approximate (lab road units, metres).
export type SenseEvent =
  | { type: "stop_line"; distanceM: number; etaS: number | null; light: "red" | "yellow" | "green" | "unreadable"; canStop: boolean }
  | { type: "crosswalk"; distanceM: number; etaS: number | null; pedestrians: number }
  | { type: "sign"; text: string; distanceM: number };

export type SenseActor = { kind: "vehicle" | "pedestrian"; side: "ahead" | "left" | "right" | "behind"; distanceM: number; headingRelDeg: number; moving: boolean };

export type SenseFeed = {
  speedMps: number;
  brakingDistanceM: number;
  horizon: SenseEvent[];
  nearby: SenseActor[];
  blindSpot: { left: boolean; right: boolean };
};

export const SENSOR = { rangeM: 80, lightReadableM: 60, signReadableM: 40, forwardHalfFovDeg: 35, blindSpotBackM: 8, blindSpotForwardM: 2, maxBraking: 6.5 } as const;

export type SenseWorld = {
  car: { x: number; z: number; heading: number; speed: number };
  frontOffset: number;
  stopLineZ: number | null;
  crosswalkZ: number | null;
  light: "red" | "yellow" | "green" | null;
  sign: string | null;
  actors: { kind: "vehicle" | "pedestrian"; x: number; z: number; heading: number; moving: boolean }[];
};

const deg = (rad: number) => rad * 180 / Math.PI;
const eta = (distance: number, speed: number) => (speed > 0.3 ? Math.round(distance / speed * 10) / 10 : null);
const r1 = (value: number) => Math.round(value * 10) / 10;

export function senseFeed(w: SenseWorld): SenseFeed {
  const { car } = w;
  const brakingDistanceM = r1(car.speed * car.speed / (2 * SENSOR.maxBraking));
  const front = car.z + w.frontOffset;
  const horizon: SenseEvent[] = [];
  if (w.stopLineZ !== null) {
    const distanceM = r1(w.stopLineZ - front);
    if (distanceM >= -1 && distanceM <= SENSOR.rangeM) {
      horizon.push({
        type: "stop_line", distanceM, etaS: eta(distanceM, car.speed),
        light: w.light && distanceM <= SENSOR.lightReadableM ? w.light : "unreadable",
        canStop: brakingDistanceM <= Math.max(distanceM, 0),
      });
    }
    if (w.sign && distanceM >= 0 && distanceM <= SENSOR.signReadableM) horizon.push({ type: "sign", text: w.sign, distanceM });
  }
  const nearby: SenseActor[] = [];
  const blindSpot = { left: false, right: false };
  for (const actor of w.actors) {
    const dx = actor.x - car.x;
    const dz = actor.z - car.z;
    const distanceM = r1(Math.hypot(dx, dz));
    if (distanceM > SENSOR.rangeM) continue;
    // Car frame. Lab heading h faces (sin h, cos h) in (x, z) and the car's left is (cos h, -sin h): heading 0 faces +z, left is +x.
    const forward = dx * Math.sin(car.heading) + dz * Math.cos(car.heading);
    const lateral = dx * Math.cos(car.heading) - dz * Math.sin(car.heading);
    const bearing = deg(Math.atan2(lateral, forward));
    const beside = forward < SENSOR.blindSpotForwardM && forward > -SENSOR.blindSpotBackM && Math.abs(lateral) > 1.2 && Math.abs(lateral) < 6;
    if (actor.kind === "vehicle" && beside) { if (lateral > 0) blindSpot.left = true; else blindSpot.right = true; }
    const inCone = forward > 0 && Math.abs(bearing) <= SENSOR.forwardHalfFovDeg;
    if (!inCone && !(beside && actor.kind === "vehicle")) continue;
    nearby.push({
      kind: actor.kind, distanceM, moving: actor.moving,
      side: inCone ? "ahead" : lateral > 0 ? "left" : "right",
      headingRelDeg: Math.round(deg(actor.heading - car.heading) % 360),
    });
  }
  if (w.crosswalkZ !== null) {
    const distanceM = r1(w.crosswalkZ - front);
    if (distanceM >= -1 && distanceM <= SENSOR.rangeM) {
      horizon.push({ type: "crosswalk", distanceM, etaS: eta(distanceM, car.speed), pedestrians: nearby.filter((a) => a.kind === "pedestrian").length });
    }
  }
  horizon.sort((a, b) => ("distanceM" in a ? a.distanceM : 0) - ("distanceM" in b ? b.distanceM : 0));
  return { speedMps: r1(car.speed), brakingDistanceM, horizon, nearby, blindSpot };
}
