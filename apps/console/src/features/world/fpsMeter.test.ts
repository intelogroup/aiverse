// @vitest-environment node
// Pure logic only — same header discipline as the sibling suites.

import { describe, expect, it } from "vitest";
import { FPS_WINDOW_MS, FpsMeter } from "./fpsMeter";

/** Push `seconds` of frames at a steady `fps` onto a fresh meter. */
function steady(fps: number, seconds: number): FpsMeter {
  const m = new FpsMeter();
  const step = 1000 / fps;
  const frames = Math.floor(seconds * fps);
  for (let i = 0; i <= frames; i++) m.push(i * step);
  return m;
}

describe("FpsMeter", () => {
  it("reads 0 before two frames share the window", () => {
    const m = new FpsMeter();
    expect(m.fps()).toBe(0);
    m.push(1000);
    expect(m.fps()).toBe(0);
  });

  it("a steady 60 fps stream reads ~60", () => {
    expect(steady(60, 2).fps()).toBeCloseTo(60, 0);
  });

  it("a steady 10 fps stream reads ~10", () => {
    expect(steady(10, 3).fps()).toBeCloseTo(10, 0);
  });

  it("averages over the trailing window, not the whole history", () => {
    const m = steady(120, 1); // fast first second
    // Then half a second at 20 fps: the window now covers only these.
    const step = 1000 / 20;
    for (let i = 1; i <= Math.floor(0.5 * 20); i++) m.push(1000 + i * step);
    expect(m.fps()).toBeCloseTo(20, 0);
  });

  it("reset clears the history", () => {
    const m = steady(60, 1);
    expect(m.fps()).toBeGreaterThan(0);
    m.reset();
    expect(m.fps()).toBe(0);
  });

  it("the window is the documented ~0.5 s", () => {
    expect(FPS_WINDOW_MS).toBe(500);
  });
});
