import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { plainGlass } from "./glbStage";

describe("plainGlass", () => {
  it("turns transmission glass into plain alpha glass", () => {
    const m = new THREE.MeshPhysicalMaterial({ transmission: 1 });
    plainGlass(m);
    expect(m.transmission).toBe(0);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBeLessThanOrEqual(0.3);
    expect(m.depthWrite).toBe(false);
  });
  it("leaves opaque and standard materials alone", () => {
    const p = new THREE.MeshPhysicalMaterial({ roughness: 0.4 });
    const s = new THREE.MeshStandardMaterial();
    plainGlass(p); plainGlass(s); plainGlass(undefined);
    expect(p.transparent).toBe(false);
    expect(p.opacity).toBe(1);
    expect(s.transparent).toBe(false);
  });
});
