// @vitest-environment node
// Pure math only — same header discipline as the sibling suites.

import { describe, expect, it } from "vitest";
import { COLLIDE_FLOOR, resolveCamera, resolveDistance, stepDistance } from "./cameraCollision";

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe("resolveCamera", () => {
  const target = [0, 1, 0] as const;
  const desired = [0, 1, 10] as const;

  it("no hit leaves the camera where it was asked to be", () => {
    close(resolveCamera(target, desired, null), [0, 1, 10]);
    close(resolveCamera(target, desired, Infinity), [0, 1, 10]);
  });

  it("a hit farther than the camera does nothing", () => {
    close(resolveCamera(target, desired, 25), [0, 1, 10]);
  });

  it("a hit closer than the camera pulls it in, padded", () => {
    close(resolveCamera(target, desired, 4), [0, 1, 4 - 0.35]);
    close(resolveCamera(target, desired, 4, 0.5), [0, 1, 3.5]);
  });

  it("a hit just behind the camera (within the pad) still pulls it in by the pad", () => {
    close(resolveCamera(target, desired, 10.2), [0, 1, 10.2 - 0.35]);
  });

  it("a hit right at the target clamps to the floor distance, not through it", () => {
    close(resolveCamera(target, desired, 0.1), [0, 1, COLLIDE_FLOOR]);
    close(resolveCamera(target, desired, 0), [0, 1, COLLIDE_FLOOR]);
  });

  it("follows a diagonal ray", () => {
    const p = resolveCamera([0, 0, 0], [3, 0, 4], 2.85, 0.35);
    close(p, [1.5, 0, 2]);
  });

  it("zero length returns the desired point unchanged", () => {
    close(resolveCamera(target, target, 0), [0, 1, 0]);
    expect(resolveDistance(0, 1)).toBe(0);
  });

  it("never pushes a camera closer than the floor outwards", () => {
    expect(resolveDistance(0.3, 0.1)).toBeCloseTo(0.3, 6);
  });
});

describe("stepDistance", () => {
  it("snaps inwards immediately", () => {
    expect(stepDistance(10, 3, 1 / 60)).toBe(3);
  });
  it("eases outwards, damped, and settles", () => {
    const a = stepDistance(3, 10, 1 / 60);
    expect(a).toBeGreaterThan(3);
    expect(a).toBeLessThan(4);
    let d = 3;
    for (let i = 0; i < 120; i++) d = stepDistance(d, 10, 1 / 60);
    expect(d).toBe(10);
  });
});
