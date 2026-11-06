// @vitest-environment node
// The real Detour crowd (WASM) driven through the body controller, headless: what a reversal looks like
// with the legacy snap-to-velocity pipeline versus bodyController.ts. No rendering, no LLM.

import { describe, expect, it } from "vitest";
import { DEG, newBodyState, stepBody, wrapAngle } from "./bodyController";
import { createPlatformCrowd } from "./locomotion";

const DT = 1 / 60;
const WALK_SPEED = 0.8746;

interface Run {
  heading: number[];
  speed: number[];
  turning: boolean[];
  pos: [number, number][];
  flipAt: number;
  slide: number;
  seconds: number;
}

async function run(legacy: boolean, seed: number): Promise<Run> {
  const crowd = await createPlatformCrowd(9.7, 1, { seed, keepOutRadius: 2.2, maxSpeed: 1.0 });
  crowd.setControlled(0, true);
  crowd.moveAgentTo(0, 7, 4);
  const st = newBodyState(0);
  const r: Run = { heading: [], speed: [], turning: [], pos: [], flipAt: -1, slide: 0, seconds: 14 };
  let reversed = false;
  let walkW = 0;
  for (let k = 0; k < r.seconds / DT; k++) {
    const f = crowd.step(DT)[0];
    let heading = f.heading;
    let turning = false;
    let stride = 0;
    if (legacy) {
      walkW = Math.min(1, Math.max(0, walkW + ((f.speed > 0.1 ? 1 : 0) - walkW) * Math.min(1, DT / 0.25)));
      stride = walkW * Math.min(1.4, Math.max(0.7, f.speed / WALK_SPEED)) * WALK_SPEED;
    } else {
      const out = stepBody(st, { vx: f.velocity[0], vz: f.velocity[1], speed: f.speed, intent: f.speed > 0.1 ? null : f.heading, walkSpeed: WALK_SPEED }, DT);
      heading = out.heading;
      turning = out.turn !== null;
      crowd.setSpeedScale(0, out.speedScale);
      stride = out.walkWeight * out.walkTimeScale * WALK_SPEED;
    }
    r.slide += Math.abs(f.speed - stride) * DT;
    // "wait, go back": once it is cruising, send it 5 m straight behind itself
    if (!reversed && f.speed > 0.85 && k * DT > 1) {
      reversed = true;
      r.flipAt = k * DT;
      const n = Math.hypot(f.velocity[0], f.velocity[1]) || 1;
      let tx = f.position[0] - (f.velocity[0] / n) * 5;
      let tz = f.position[1] - (f.velocity[1] / n) * 5;
      const rr = Math.hypot(tx, tz);
      if (rr > 8.6) {
        tx *= 8.6 / rr;
        tz *= 8.6 / rr;
      }
      crowd.moveAgentTo(0, tx, tz);
    }
    r.heading.push(heading);
    r.speed.push(f.speed);
    r.turning.push(turning);
    r.pos.push(f.position);
  }
  crowd.dispose();
  return r;
}

const rate = (r: Run, from: number, to: number): { maxDegPerS: number; bigSteps: number } => {
  let m = 0;
  let big = 0;
  for (let i = Math.max(1, Math.floor(from / DT)); i < Math.min(r.heading.length, Math.floor(to / DT)); i++) {
    const step = Math.abs(wrapAngle(r.heading[i] - r.heading[i - 1]));
    m = Math.max(m, step / DT / DEG);
    if (step > 20 * DEG) big++; // > 1200 deg/s: a visible pop at 60 fps
  }
  return { maxDegPerS: m, bigSteps: big };
};

describe("reversal with the real Detour crowd", () => {
  it("legacy snaps; the controller stops, turns on its clip, and walks back, never leaving the deck", async () => {
    const rows: string[] = [];
    for (const seed of [3, 11, 42]) {
      const legacy = await run(true, seed);
      const body = await run(false, seed);
      expect(legacy.flipAt).toBeGreaterThan(0);
      expect(body.flipAt).toBeGreaterThan(0);
      const lw = rate(legacy, legacy.flipAt, legacy.flipAt + 5);
      const bw = rate(body, body.flipAt, body.flipAt + 5);
      // legacy: the heading swings by tens of degrees in single 1/60 s frames
      expect(lw.maxDegPerS).toBeGreaterThan(1500);
      expect(lw.bigSteps).toBeGreaterThan(0);
      // controller: nothing faster than the walking arc / clip allows, and no big single-frame steps
      expect(bw.maxDegPerS).toBeLessThan(260);
      expect(bw.bigSteps).toBe(0);
      // it did turn in place with the clip, then set off again at pace
      expect(body.turning.slice(Math.floor(body.flipAt / DT)).some(Boolean)).toBe(true);
      const resumedAt = body.speed.findIndex((v, i) => i > Math.floor(body.flipAt / DT) + 20 && v > 0.8);
      expect(resumedAt).toBeGreaterThan(-1);
      expect(resumedAt * DT - body.flipAt).toBeLessThan(5.5);
      for (const [x, z] of body.pos) expect(Math.hypot(x, z)).toBeLessThan(9.7);
      expect(body.slide).toBeLessThan(legacy.slide);
      rows.push(`seed ${seed}: legacy max ${lw.maxDegPerS.toFixed(0)} deg/s (${lw.bigSteps} big steps), slide ${legacy.slide.toFixed(2)} m | controller max ${bw.maxDegPerS.toFixed(0)} deg/s, resumes ${(resumedAt * DT - body.flipAt).toFixed(1)} s after the order, slide ${body.slide.toFixed(2)} m`);
    }
    // eslint-disable-next-line no-console
    console.log(rows.join("\n"));
  }, 120000);
});
