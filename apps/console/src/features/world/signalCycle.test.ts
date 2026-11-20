import { describe, expect, it } from "vitest";
import { SIGNAL_PERIOD, SIGNAL_PLAN, signalState } from "./signalCycle";

describe("signalCycle", () => {
  it("runs green, yellow, red for one direction, then the other", () => {
    expect(signalState(0)).toEqual({ ns: "green", ew: "red" });
    expect(signalState(SIGNAL_PLAN.green + 0.1)).toEqual({ ns: "yellow", ew: "red" });
    expect(signalState(SIGNAL_PLAN.green + SIGNAL_PLAN.yellow + 0.1)).toEqual({ ns: "red", ew: "red" });
    expect(signalState(SIGNAL_PERIOD / 2)).toEqual({ ns: "red", ew: "green" });
  });
  it("never shows green or yellow to both directions at once", () => {
    for (let t = 0; t < SIGNAL_PERIOD * 2; t += 0.1) {
      const s = signalState(t);
      expect(s.ns === "red" || s.ew === "red").toBe(true);
    }
  });
  it("repeats and accepts negative time", () => {
    expect(signalState(SIGNAL_PERIOD + 1)).toEqual(signalState(1));
    expect(signalState(-1)).toEqual(signalState(SIGNAL_PERIOD - 1));
  });
});
