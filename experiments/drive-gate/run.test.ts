// The gate's own judge: what counts as a pass, and what the agent is told. A gate that miscounts proves nothing about the car.
import { expect, test } from "bun:test";
import { TASK, passes } from "./run";

const m = (junctions: number, red = 0, collision = 0) => ({ junctions: Array.from({ length: junctions }, (_, i) => i), red, collision });

test("a run passes with at least 3 junctions, no red light and no collision", () => {
  expect(passes(m(3))).toBe(true);
  expect(passes(m(5))).toBe(true);
});

test("a run fails on too few junctions, a red light or a collision, whatever else went right", () => {
  expect(passes(m(0))).toBe(false);
  expect(passes(m(2))).toBe(false);
  expect(passes(m(4, 1, 0))).toBe(false);
  expect(passes(m(4, 0, 1))).toBe(false);
  expect(passes(m(9, 2, 3))).toBe(false);
});

test("the task names the car and where it is, so a cold agent cannot drive the other red car or search for it", () => {
  expect(TASK).toContain("car-east");
  expect(TASK).toMatch(/x -128, z -14/);
  expect(TASK).toMatch(/car-tea.*not yours/);
  expect(TASK).toMatch(/north/i);
  expect(TASK).toMatch(/RIGHT/);
});
