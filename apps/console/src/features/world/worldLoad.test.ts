import { describe, expect, it } from "vitest";
import {
  LOAD_ESCAPE_MS,
  LOAD_PROGRESS_MS,
  LOAD_SKELETON_MS,
  LOAD_TIMEOUT_MS,
  loadPercent,
  worldLoadPhase,
  type WorldLoadInput,
} from "./worldLoad";

const at = (elapsedMs: number, over: Partial<WorldLoadInput> = {}): WorldLoadInput => ({
  presented: false,
  failed: false,
  elapsedMs,
  ...over,
});

describe("worldLoadPhase (E1: skeleton-states thresholds)", () => {
  it("shows nothing for the first 300 ms — a fast load must not flash", () => {
    expect(worldLoadPhase(at(0))).toBe("waiting");
    expect(worldLoadPhase(at(LOAD_SKELETON_MS - 1))).toBe("waiting");
  });

  it("shows the skeleton from 300 ms to 4 s", () => {
    expect(worldLoadPhase(at(LOAD_SKELETON_MS))).toBe("skeleton");
    expect(worldLoadPhase(at(LOAD_PROGRESS_MS - 1))).toBe("skeleton");
  });

  it("escalates to determinate progress at 4 s", () => {
    expect(worldLoadPhase(at(LOAD_PROGRESS_MS))).toBe("progress");
    expect(worldLoadPhase(at(LOAD_ESCAPE_MS - 1))).toBe("progress");
  });

  it("adds a way out at 10 s (stalled)", () => {
    expect(worldLoadPhase(at(LOAD_ESCAPE_MS))).toBe("stalled");
    expect(worldLoadPhase(at(LOAD_TIMEOUT_MS - 1))).toBe("stalled");
  });

  it("fails at the 30 s timeout — never spin forever", () => {
    expect(worldLoadPhase(at(LOAD_TIMEOUT_MS))).toBe("failed");
    expect(worldLoadPhase(at(120_000))).toBe("failed");
  });

  it("fails immediately on a load error, however early", () => {
    expect(worldLoadPhase(at(50, { failed: true }))).toBe("failed");
    expect(worldLoadPhase(at(5_000, { failed: true }))).toBe("failed");
  });

  it("presented wins over every other state, including a late error", () => {
    expect(worldLoadPhase(at(0, { presented: true }))).toBe("ready");
    expect(worldLoadPhase(at(120_000, { presented: true }))).toBe("ready");
    expect(worldLoadPhase(at(120_000, { presented: true, failed: true }))).toBe("ready");
  });
});

describe("loadPercent", () => {
  it("clamps and rounds the manager's real progress", () => {
    expect(loadPercent(0)).toBe(0);
    expect(loadPercent(42.4)).toBe(42);
    expect(loadPercent(99.6)).toBe(100);
    expect(loadPercent(140)).toBe(100);
    expect(loadPercent(-3)).toBe(0);
    expect(loadPercent(Number.NaN)).toBe(0);
  });
});
