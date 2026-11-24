import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { AERIAL_HALF, WALK_HALF, shadowBox } from "./shadowFit";

const sun = new THREE.Vector3(0.4, 0.8, 0.3).normalize();

describe("shadowBox", () => {
  it("walking: a tight box pushed ahead of the camera", () => {
    const b = shadowBox({ x: 10, y: 1.8, z: 20, fx: 0, fz: -1 }, sun, 2048);
    expect(b.half).toBe(WALK_HALF);
    // the box centre lies on the ground line through (10, 20 - 36) seen along the sun: its offset from it is along the sun only
    const off = b.center.clone().sub(new THREE.Vector3(10, 0, 20 - WALK_HALF * 0.6));
    expect(off.clone().cross(sun).length()).toBeLessThan(b.texel * 1.5);
  });
  it("from the air: the whole city", () => {
    expect(shadowBox({ x: 170, y: 110, z: 170, fx: -1, fz: -1 }, sun, 2048).half).toBe(AERIAL_HALF);
  });
  it("small camera moves keep the box on the same texel grid (no crawling edges)", () => {
    const a = shadowBox({ x: 10, y: 1.8, z: 20, fx: 0, fz: -1 }, sun, 1024);
    const b = shadowBox({ x: 10.01, y: 1.8, z: 20.01, fx: 0, fz: -1 }, sun, 1024);
    const x = new THREE.Vector3(0, 1, 0).cross(sun).normalize();
    const da = a.center.dot(x) / a.texel, db = b.center.dot(x) / b.texel;
    expect(Math.abs(da - Math.round(da))).toBeLessThan(1e-6);
    expect(Math.abs(db - Math.round(db))).toBeLessThan(1e-6);
  });
});
