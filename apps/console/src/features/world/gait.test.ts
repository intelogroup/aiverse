// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BODY_SUMMER } from "./bodies";
import { clipDef } from "./clips";
import { approach, gaitTargets, runBand, runTimeForWalkPhase, type GaitSpec, MIN_WALK_RATE } from "./gait";
import { WALK_CONFIG } from "./walker";

const SPEC: GaitSpec = {
  walkSpeed: BODY_SUMMER.walkSpeed,
  runSpeed: BODY_SUMMER.run!.speed,
  walkDuration: clipDef("Walk")!.duration,
  runDuration: clipDef("Run")!.duration,
};

describe("gaitTargets (speed -> Idle/Walk/Run weights + cycle rate)", () => {
  it("weights always sum to 1", () => {
    for (let v = 0; v <= 3.5; v += 0.05) {
      const g = gaitTargets(v, SPEC);
      expect(g.idle + g.walk + g.run).toBeCloseTo(1, 9);
      for (const w of [g.idle, g.walk, g.run]) expect(w).toBeGreaterThanOrEqual(0);
    }
  });

  it("standing is pure Idle; the walker's walk speed is pure Walk; its run speed is pure Run", () => {
    expect(gaitTargets(0, SPEC)).toMatchObject({ idle: 1, walk: 0, run: 0 });
    expect(gaitTargets(WALK_CONFIG.walkSpeed, SPEC)).toMatchObject({ idle: 0, walk: 1, run: 0 });
    expect(gaitTargets(WALK_CONFIG.runSpeed, SPEC)).toMatchObject({ idle: 0, walk: 0, run: 1 });
  });

  it("the run weight rises monotonically across the band", () => {
    const [lo, hi] = runBand(SPEC);
    expect(lo).toBeGreaterThan(WALK_CONFIG.walkSpeed);
    expect(hi).toBeLessThan(WALK_CONFIG.runSpeed);
    let prev = -1;
    for (let v = lo; v <= hi; v += 0.02) {
      const r = gaitTargets(v, SPEC).run;
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it("planted feet match ground speed: clip playback = ground speed / natural speed (no skate)", () => {
    const walk = gaitTargets(1.3, SPEC);
    expect(walk.cycleRate * SPEC.walkDuration).toBeCloseTo(1.3 / SPEC.walkSpeed, 6); // Walk timeScale 1.204
    const run = gaitTargets(2.7, SPEC);
    expect(run.cycleRate * SPEC.runDuration).toBeCloseTo(2.7 / SPEC.runSpeed, 6); // Run timeScale 1.010
    // Mid-blend: the stride is the weighted mix, so the foot speed of the blend tracks ground speed.
    const v = 1.9;
    const m = gaitTargets(v, SPEC);
    const r = m.run / (m.walk + m.run);
    const stride = SPEC.walkSpeed * SPEC.walkDuration * (1 - r) + SPEC.runSpeed * SPEC.runDuration * r;
    expect(m.cycleRate * stride).toBeCloseTo(v, 6);
  });

  it("starting from rest never plays slower than MIN_WALK_RATE", () => {
    expect(gaitTargets(0.1, SPEC).cycleRate * SPEC.walkDuration).toBeCloseTo(MIN_WALK_RATE, 6);
  });

  it("a slow walk above the floor plays at ground speed (no skate from the floor)", () => {
    const v = SPEC.walkSpeed * 0.45; // 0.6 floor used to play this at 0.6x: feet ran ahead of the body
    expect(gaitTargets(v, SPEC).cycleRate * SPEC.walkSpeed * SPEC.walkDuration).toBeCloseTo(v, 6);
  });
});

describe("crossfade + phase helpers", () => {
  it("approach is rate limited and lands exactly", () => {
    expect(approach(0, 1, 0.1, 0.25)).toBeCloseTo(0.4, 9);
    expect(approach(0.9, 1, 0.1, 0.25)).toBe(1);
    expect(approach(0.3, 0, 0.1, 0.25)).toBeCloseTo(0, 9);
  });

  it("run clock follows the walk phase with the measured offset, wrapped", () => {
    expect(runTimeForWalkPhase(0.5, -0.067, 0.7333)).toBeCloseTo(0.433 * 0.7333, 6);
    expect(runTimeForWalkPhase(0.02, -0.067, 0.7333)).toBeCloseTo(0.953 * 0.7333, 6);
  });
});
