import { describe, expect, test } from "bun:test";
import { bottleTilt, stallEase } from "./stallConsumables";
// Permanent regression for AIV-STALL-MOTION-SHAPE-001: the stall motion
// helpers are total over numeric inputs — finite outputs only.
describe("stall motion shape totality", () => {
  test("stallEase is finite in [0,1] for hostile values", () => {
    for (const v of [NaN, Infinity, -Infinity, -1, 0, 0.5, 1, 2, 1e12]) {
      const r = stallEase(v);
      expect(Number.isFinite(r) && r >= 0 && r <= 1).toBe(true);
    }
    expect(stallEase(0.5)).toBe(0.5);
    expect(stallEase(NaN)).toBe(0);
  });
  test("bottleTilt is finite for hostile values", () => {
    for (const v of [NaN, Infinity, -Infinity, -1, 0, 1, 1e12]) {
      expect(Number.isFinite(bottleTilt(v))).toBe(true);
    }
  });
});
