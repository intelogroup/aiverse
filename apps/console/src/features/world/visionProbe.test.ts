// @vitest-environment node
// Pure math only — same header discipline as the sibling suites.

import { describe, expect, it } from "vitest";
import {
  FPS_EMA_ALPHA,
  ema,
  initialProbeStats,
  recordCapture,
  shouldCapture,
} from "./visionProbe";

describe("ema", () => {
  it("steps from prev toward sample by alpha", () => {
    expect(ema(0, 10, 0.2)).toBeCloseTo(2);
    expect(ema(10, 10, 0.2)).toBeCloseTo(10);
    expect(ema(5, 15, FPS_EMA_ALPHA)).toBeCloseTo(7);
  });

  it("converges on a constant sample stream", () => {
    let v = 0;
    for (let i = 0; i < 100; i++) v = ema(v, 8, FPS_EMA_ALPHA);
    expect(v).toBeCloseTo(8, 6);
  });
});

describe("shouldCapture (cadence gating)", () => {
  it("always fires for the first capture", () => {
    expect(shouldCapture(1234, null, 5)).toBe(true);
  });

  it("never fires when the target rate is off (0 or negative)", () => {
    expect(shouldCapture(1234, null, 0)).toBe(false);
    expect(shouldCapture(99999, 0, 0)).toBe(false);
    expect(shouldCapture(99999, 0, -3)).toBe(false);
  });

  it("gates on the target interval", () => {
    // 5 fps => one capture per 200 ms.
    expect(shouldCapture(199, 0, 5)).toBe(false);
    expect(shouldCapture(200, 0, 5)).toBe(true);
    expect(shouldCapture(450, 0, 5)).toBe(true);
    // 1 fps => one per second; 10 fps => one per 100 ms.
    expect(shouldCapture(999, 0, 1)).toBe(false);
    expect(shouldCapture(1000, 0, 1)).toBe(true);
    expect(shouldCapture(99, 0, 10)).toBe(false);
    expect(shouldCapture(100, 0, 10)).toBe(true);
  });
});

describe("recordCapture (probe statistics)", () => {
  it("seeds cost from the first capture and claims no fps yet", () => {
    const s = recordCapture(initialProbeStats(), 1000, 4);
    expect(s.captures).toBe(1);
    expect(s.lastAt).toBe(1000);
    expect(s.costEmaMs).toBeCloseTo(4);
    expect(s.fpsEma).toBe(0);
  });

  it("seeds fps from the first measurable interval (second capture)", () => {
    let s = recordCapture(initialProbeStats(), 1000, 4);
    s = recordCapture(s, 1200, 6); // 200 ms later => 5 fps
    expect(s.captures).toBe(2);
    expect(s.fpsEma).toBeCloseTo(5);
    expect(s.costEmaMs).toBeCloseTo(ema(4, 6, FPS_EMA_ALPHA));
  });

  it("EMA-blends fps and cost once seeded", () => {
    let s = initialProbeStats();
    s = recordCapture(s, 0, 2);
    s = recordCapture(s, 100, 2); // 10 fps seed
    const fpsBefore = s.fpsEma;
    s = recordCapture(s, 300, 12); // 200 ms interval => 5 fps sample
    expect(s.fpsEma).toBeCloseTo(ema(fpsBefore, 5, FPS_EMA_ALPHA));
    expect(s.costEmaMs).toBeCloseTo(ema(ema(2, 2, FPS_EMA_ALPHA), 12, FPS_EMA_ALPHA));
    expect(s.captures).toBe(3);
  });

  it("tracks a steady cadence at the target rate", () => {
    let s = initialProbeStats();
    for (let i = 0; i <= 20; i++) s = recordCapture(s, i * 200, 3);
    expect(s.fpsEma).toBeCloseTo(5, 6);
    expect(s.costEmaMs).toBeCloseTo(3, 6);
    expect(s.captures).toBe(21);
  });

  it("ignores a non-positive interval instead of claiming infinite fps", () => {
    let s = recordCapture(initialProbeStats(), 500, 2);
    s = recordCapture(s, 500, 2); // same timestamp: no interval to measure
    expect(s.fpsEma).toBe(0);
    expect(s.captures).toBe(2);
  });
});
