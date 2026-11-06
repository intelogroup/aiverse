// gait.ts — Idle / Walk / Run blend weights and one shared cycle rate from ground speed.
//
// Pure and three-free (like bodyController.ts). CastFigure applies the result to the mixer for frames whose driver
// opts in (`AgentFrame.gait`, set by the City 3 walker); crowd frames never do, so Agora is untouched.
//
// One phase drives both locomotion clips: Walk plays at `cycleRate * walkDuration`, and Run's clock is slaved to
// Walk's phase (+ the measured touchdown offset) so a crossfade never mixes a left-foot plant with a right-foot
// swing. The stride the cycle rate divides by is lerped Walk -> Run with the run weight, so at every speed in the
// blend the planted foot travels backwards at (close to) ground speed.

export interface GaitSpec {
  /** Natural ground speed of the Walk cycle, m/s (bodies.ts walkSpeed). */
  walkSpeed: number;
  /** Natural ground speed of the Run cycle, m/s (bodies.ts runSpeed). */
  runSpeed: number;
  walkDuration: number;
  runDuration: number;
}

export interface GaitTargets {
  idle: number;
  walk: number;
  run: number;
  /** Locomotion cycles per second (one cycle = one stride = two steps). */
  cycleRate: number;
}

/** Below this the body counts as standing; the Idle -> moving fade spans MOVE_LO..MOVE_HI m/s. */
export const MOVE_LO = 0.08;
export const MOVE_HI = 0.35;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export function smoothstep(lo: number, hi: number, x: number): number {
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Speed band of the Walk -> Run crossfade: pure Walk up to a brisk walk, pure Run a little under run speed. */
export function runBand(spec: GaitSpec): [number, number] {
  return [spec.walkSpeed * 1.25, spec.runSpeed * 0.85];
}

export function gaitTargets(speed: number, spec: GaitSpec): GaitTargets {
  const s = Math.max(0, speed);
  const moving = smoothstep(MOVE_LO, MOVE_HI, s);
  const [lo, hi] = runBand(spec);
  const r = smoothstep(lo, hi, s);
  return { idle: 1 - moving, walk: moving * (1 - r), run: moving * r, cycleRate: cycleRateFor(s, r, spec) };
}

/**
 * Cycles per second at ground speed `speed` when Run is `runMix` (0..1) of the locomotion blend: speed / the
 * mixed stride. Starting/stopping never plays slower than 0.6x the walk cycle (no slow-motion shuffle) nor faster
 * than 1.5x the run cycle.
 */
export function cycleRateFor(speed: number, runMix: number, spec: GaitSpec): number {
  const walkStride = spec.walkSpeed * spec.walkDuration;
  const runStride = spec.runSpeed * spec.runDuration;
  const stride = walkStride + (runStride - walkStride) * clamp(runMix, 0, 1);
  return clamp(Math.max(0, speed) / stride, 0.6 / spec.walkDuration, 1.5 / spec.runDuration);
}

/** Rate-limited approach of `cur` to `target` (a crossfade of `fadeS` seconds for a full 0 -> 1). */
export function approach(cur: number, target: number, dt: number, fadeS: number): number {
  const step = dt / fadeS;
  return target > cur ? Math.min(target, cur + step) : Math.max(target, cur - step);
}

/** Run clock slaved to the Walk phase (0..1), with the measured Run-minus-Walk touchdown offset. Returns run time (s). */
export function runTimeForWalkPhase(walkPhase: number, runPhaseOffset: number, runDuration: number): number {
  const p = (((walkPhase + runPhaseOffset) % 1) + 1) % 1;
  return p * runDuration;
}
