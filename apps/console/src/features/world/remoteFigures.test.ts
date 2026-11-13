// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { registerRemoteFigure, remoteFiguresNear, SELF_HIDE_RADIUS_M, unregisterRemoteFigure } from "./remoteFigures";

const group = () => new THREE.Group();
afterEach(() => { for (const n of [1, 2, 3]) unregisterRemoteFigure(n); });

describe("remoteFiguresNear (first-person capture hides the camera's own streamed body)", () => {
  it("returns figures within the radius and leaves far ones", () => {
    const own = group(), other = group();
    registerRemoteFigure(1, { group: own, at: () => [10.3, 5.2] });
    registerRemoteFigure(2, { group: other, at: () => [14, 5] });
    expect(remoteFiguresNear(10, 5)).toEqual([own]);
    expect(remoteFiguresNear(14, 5.5)).toEqual([other]);
  });
  it("counts a stand-in that lags the true body by its arrival radius (0.4 m) plus the eye offset", () => {
    const own = group();
    registerRemoteFigure(1, { group: own, at: () => [0, 0] });
    expect(remoteFiguresNear(0.4, 0.3)).toEqual([own]);
    expect(SELF_HIDE_RADIUS_M).toBeGreaterThan(0.4 + 0.22);
  });
  it("ignores figures with no frame yet, and forgets unregistered ones", () => {
    registerRemoteFigure(1, { group: group(), at: () => undefined });
    expect(remoteFiguresNear(0, 0)).toEqual([]);
    registerRemoteFigure(2, { group: group(), at: () => [0, 0] });
    unregisterRemoteFigure(2);
    expect(remoteFiguresNear(0, 0)).toEqual([]);
  });
  it("a body just beyond the radius stays visible (others in front of the camera are kept)", () => {
    registerRemoteFigure(3, { group: group(), at: () => [SELF_HIDE_RADIUS_M + 0.2, 0] });
    expect(remoteFiguresNear(0, 0)).toEqual([]);
  });
});
