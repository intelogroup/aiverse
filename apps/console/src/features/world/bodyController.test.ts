import { describe, expect, it } from "vitest";
import {
  DEFAULT_BODY_PARAMS as P,
  DEG,
  TURN_LEFT,
  TURN_RIGHT,
  TURN_YAW0,
  newBodyState,
  speedScaleForError,
  stepBody,
  turnProgress,
  wrapAngle,
} from "./bodyController";

const DT = 1 / 60;
const WALK_SPEED = 0.8746; // bodies.ts: Body Block

describe("turn clip curves", () => {
  it("run from 0 to 1, monotone enough that a heading never runs backwards by more than the foot-sway noise", () => {
    for (const d of [TURN_LEFT, TURN_RIGHT]) {
      expect(turnProgress(d, 0)).toBeCloseTo(0);
      expect(turnProgress(d, 1)).toBeCloseTo(1);
      let worst = 0;
      for (let k = 1; k <= 100; k++) worst = Math.min(worst, turnProgress(d, k / 100) - turnProgress(d, (k - 1) / 100));
      expect(worst).toBeGreaterThan(-0.02);
    }
  });
  it("left is a positive heading change, right negative (the cast rig faces +Z; its left is +X)", () => {
    expect(TURN_LEFT.net).toBeGreaterThan(0);
    expect(TURN_RIGHT.net).toBeLessThan(0);
    expect(Math.abs(TURN_LEFT.net)).toBeCloseTo(90 * DEG, 1);
  });
});

describe("speedScaleForError", () => {
  it("is 1 when aligned, falls smoothly, and reaches a halt when facing away", () => {
    expect(speedScaleForError(10 * DEG)).toBe(1);
    expect(speedScaleForError(115 * DEG)).toBe(0);
    let prev = 1;
    for (let d = 30; d <= 110; d += 5) {
      const s = speedScaleForError(d * DEG);
      expect(s).toBeLessThanOrEqual(prev + 1e-9);
      prev = s;
    }
  });
});

// ---------- closed-loop simulation: a stub crowd agent (accelerates at 8 m/s^2 like Detour) ----------
interface Trace {
  t: number[];
  heading: number[];
  speed: number[];
  turning: boolean[];
  slide: number; // integrated foot-slide proxy, m
}
function simulate(opts: { legacy: boolean; cruise: number; seconds: number; flipAt: number }): Trace {
  const tr: Trace = { t: [], heading: [], speed: [], turning: [], slide: 0 };
  const st = newBodyState(0);
  let vx = 0;
  let vz = 0;
  let px = 0;
  let pz = 0;
  let legacyHeading = 0;
  let weightLegacy = 0;
  for (let k = 0; k < opts.seconds / DT; k++) {
    const t = k * DT;
    const dir = t < opts.flipAt ? 1 : -1; // the agent walks +Z, then decides "go back"
    const speed = Math.hypot(vx, vz);
    let scale = 1;
    let heading: number;
    let walkW: number;
    let walkTs: number;
    let turning = false;
    if (opts.legacy) {
      if (speed > 0.1) legacyHeading = Math.atan2(vx, vz);
      heading = legacyHeading;
      weightLegacy = Math.min(1, Math.max(0, weightLegacy + ((speed > 0.1 ? 1 : 0) - weightLegacy) * Math.min(1, DT / 0.25)));
      walkW = weightLegacy;
      walkTs = Math.min(1.4, Math.max(0.7, speed / WALK_SPEED));
    } else {
      const out = stepBody(st, { vx, vz, speed, intent: null, walkSpeed: WALK_SPEED }, DT);
      heading = out.heading;
      scale = out.speedScale;
      walkW = out.walkWeight;
      walkTs = out.walkTimeScale;
      turning = out.turn !== null;
    }
    // stub crowd: steer the velocity toward dir * cruise * scale at 8 m/s^2
    const wantZ = dir * opts.cruise * scale;
    const dz = wantZ - vz;
    const step = 8 * DT;
    vz += Math.abs(dz) <= step ? dz : Math.sign(dz) * step;
    pz += vz * DT;
    px += vx * DT;
    // foot-slide proxy: ground speed the legs do not account for (idle legs account for none; walk legs for timeScale*walkSpeed)
    const stride = walkW * walkTs * WALK_SPEED;
    tr.slide += Math.abs(Math.hypot(vx, vz) - stride) * DT;
    tr.t.push(t);
    tr.heading.push(heading);
    tr.speed.push(Math.hypot(vx, vz));
    tr.turning.push(turning);
  }
  void px;
  void pz;
  return tr;
}
const maxRate = (h: number[]): number => {
  let m = 0;
  for (let i = 1; i < h.length; i++) m = Math.max(m, Math.abs(wrapAngle(h[i] - h[i - 1])) / DT);
  return m / DEG;
};

describe("reversal ('wait, go back')", () => {
  const legacy = simulate({ legacy: true, cruise: 1.0, seconds: 10, flipAt: 3 });
  const body = simulate({ legacy: false, cruise: 1.0, seconds: 10, flipAt: 3 });

  it("legacy flips the body 180 degrees in a single frame (the bug)", () => {
    expect(maxRate(legacy.heading)).toBeGreaterThan(5000);
  });
  it("the controller never turns faster than the clip or the walking arc allows", () => {
    // free turning is capped at 200 deg/s; a turn clip at urgency 1.4 peaks well under that
    expect(maxRate(body.heading)).toBeLessThan(260);
  });
  it("the body stops, turns around and sets off again, facing the new direction", () => {
    const after = body.t.findIndex((t) => t > 3);
    const turned = body.turning.slice(after).some(Boolean);
    expect(turned).toBe(true); // turn-in-place clip used, not a spin in Idle
    const last = body.heading[body.heading.length - 1];
    expect(Math.abs(wrapAngle(last - Math.PI))).toBeLessThan(10 * DEG);
    expect(body.speed[body.speed.length - 1]).toBeGreaterThan(0.8); // walking back at pace
  });
  it("is quicker to resume than a human would find odd: the reversal completes inside 4 s", () => {
    const flipIdx = body.t.findIndex((t) => t > 3);
    const resumed = body.speed.findIndex((v, i) => i > flipIdx + 30 && v > 0.8 && Math.abs(wrapAngle(body.heading[i] - Math.PI)) < 15 * DEG);
    expect(resumed).toBeGreaterThan(-1);
    expect(body.t[resumed] - 3).toBeLessThan(4);
  });
  it("legs account for more of the ground speed than before (lower foot-slide proxy)", () => {
    expect(body.slide).toBeLessThan(legacy.slide);
    // eslint-disable-next-line no-console
    console.log(`reversal: legacy max ${maxRate(legacy.heading).toFixed(0)} deg/s, slide ${legacy.slide.toFixed(2)} m | controller max ${maxRate(body.heading).toFixed(0)} deg/s, slide ${body.slide.toFixed(2)} m`);
  });
});

describe("small corrections and steering", () => {
  it("a 20-degree path bend is followed smoothly at full speed (no throttle, no turn clip)", () => {
    const st = newBodyState(0);
    let throttled = false;
    let turned = false;
    for (let k = 0; k < 120; k++) {
      const a = 20 * DEG;
      const out = stepBody(st, { vx: Math.sin(a), vz: Math.cos(a), speed: 1, intent: null, walkSpeed: WALK_SPEED }, DT);
      throttled ||= out.speedScale < 1;
      turned ||= out.turn !== null;
    }
    expect(throttled).toBe(false);
    expect(turned).toBe(false);
    expect(st.heading).toBeCloseTo(20 * DEG, 2);
  });
  it("a standing body with a face intent 50 degrees off just rotates (no clip below the in-place threshold)", () => {
    const st = newBodyState(0);
    let turned = false;
    for (let k = 0; k < 120; k++) turned ||= stepBody(st, { vx: 0, vz: 0, speed: 0, intent: 50 * DEG, walkSpeed: WALK_SPEED }, DT).turn !== null;
    expect(turned).toBe(false);
    expect(st.heading).toBeCloseTo(50 * DEG, 2);
  });
  it("a standing body asked to face 90 degrees away plays exactly one quarter-turn clip and lands on target", () => {
    const st = newBodyState(0);
    const clips = new Set<string>();
    let frames = 0;
    for (let k = 0; k < 600 && (st.turn || k === 0 || Math.abs(wrapAngle(90 * DEG - st.heading)) > 5 * DEG); k++, frames++) {
      const out = stepBody(st, { vx: 0, vz: 0, speed: 0, intent: 90 * DEG, walkSpeed: WALK_SPEED }, DT);
      if (out.turn) clips.add(out.turn.clip);
    }
    expect([...clips]).toEqual(["TurnLeft90"]);
    expect(st.heading).toBeCloseTo(90 * DEG, 1);
    expect(frames / 60).toBeLessThan(1.5);
  });
  it("the turn clip's own pelvis rotation equals the heading change, frame by frame (planted feet)", () => {
    const st = newBodyState(0);
    let prev = 0;
    for (let k = 0; k < 120; k++) {
      const out = stepBody(st, { vx: 0, vz: 0, speed: 0, intent: -80 * DEG, walkSpeed: WALK_SPEED }, DT);
      if (out.turn) {
        expect(wrapAngle(out.heading - out.turn.yaw)).toBeCloseTo(0, 6); // heading = start (0) + the clip's yaw
        expect(out.turn.baked - out.turn.yaw).toBeCloseTo(TURN_YAW0, 9); // the cancel carries the clip's constant start offset too
        prev = out.turn.yaw;
      }
    }
    expect(prev).toBeLessThan(0); // a right turn
  });
});

describe("cost", () => {
  it("1000 bodies for one second of frames costs about 1% of one core (no model calls, no allocation in the loop)", () => {
    const states = Array.from({ length: 1000 }, (_, i) => newBodyState(i * 0.01));
    const input = { vx: 0.7, vz: 0.7, speed: 1, intent: null, walkSpeed: WALK_SPEED };
    const t0 = performance.now();
    for (let f = 0; f < 60; f++) for (const s of states) stepBody(s, input, DT);
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`1000 bodies x 60 frames: ${ms.toFixed(1)} ms (${((ms / 1000) * 100).toFixed(2)}% of one core-second)`);
    expect(ms).toBeLessThan(100);
  });
});

describe("params", () => {
  it("keeps the thresholds in order, or the throttle and the in-place turn would fight", () => {
    expect(P.fullSpeedErr).toBeLessThan(P.inPlaceErr); // never throttle a body that is not about to turn in place
    expect(P.inPlaceErr).toBeLessThan(P.stopErr); // a halt is demanded after the in-place turn becomes possible
    expect(P.moveSpeed).toBeLessThan(P.stopSpeed);
  });
});
