// @vitest-environment node
// Body collision + separation (Phase 4): the solver and the steering
// layer. (The navmesh-clamp integration lives in tests/navmesh-assets.test.ts.)

import { describe, expect, it } from "vitest";
import { avoidVelocity, separateBodies, type BodyDisc } from "./separation";

const disc = (id: string, x: number, z: number, extra: Partial<BodyDisc> = {}): BodyDisc => ({
  id, x, y: 0.2, z, vx: 0, vz: 0, ...extra,
});
const dist = (a: BodyDisc, b: BodyDisc) => Math.hypot(b.x - a.x, b.z - a.z);

describe("separation solver", () => {
  it("resolves two overlapping circles to at least the combined diameter", () => {
    const a = disc("a", 0, 0);
    const b = disc("b", 0.3, 0);
    let res = separateBodies([a, b]);
    expect(res.maxPenetrationBefore).toBeCloseTo(0.4, 5);
    for (let i = 0; i < 12 && res.maxPenetrationAfter > 0.001; i++) res = separateBodies([a, b]);
    expect(dist(a, b)).toBeGreaterThanOrEqual(0.7 - 1e-6);
    expect(res.maxPenetrationAfter).toBeLessThanOrEqual(0.001);
  });

  it("never pops: one call moves a body at most the per-tick cap", () => {
    const a = disc("a", 0, 0);
    const b = disc("b", 0.05, 0); // near-total overlap: the uncapped push would be ~0.33 m each
    separateBodies([a, b]);
    expect(Math.hypot(a.x, a.z)).toBeLessThanOrEqual(0.09 + 1e-9);
    expect(Math.hypot(b.x - 0.05, b.z)).toBeLessThanOrEqual(0.09 + 1e-9);
  });

  it("anchored bodies do not move; the free body takes the whole push", () => {
    const anchor = disc("anchor", 0, 0, { anchored: true });
    const free = disc("free", 0.4, 0);
    separateBodies([anchor, free]);
    expect(anchor.x).toBe(0);
    expect(anchor.z).toBe(0);
    expect(free.x).toBeGreaterThan(0.4);
  });

  it("two anchored bodies are left exactly as they are", () => {
    const a = disc("a", 0, 0, { anchored: true });
    const b = disc("b", 0.2, 0, { anchored: true });
    const res = separateBodies([a, b]);
    expect(a.x).toBe(0);
    expect(b.x).toBe(0.2);
    expect(res.movedBodies).toBe(0);
  });

  it("ignores bodies on other floors", () => {
    const a = disc("a", 0, 0);
    const b = disc("b", 0.1, 0, { y: 3.9 }); // one storey up: no interaction
    const res = separateBodies([a, b]);
    expect(res.pairsResolved).toBe(0);
    expect(a.x).toBe(0);
    expect(b.x).toBe(0.1);
  });

  it("separates a concentric pair deterministically (no jitter seed)", () => {
    const run = () => {
      const a = disc("a", 5, 5);
      const b = disc("b", 5, 5);
      for (let i = 0; i < 12; i++) separateBodies([a, b]);
      return [a.x, a.z, b.x, b.z];
    };
    const r1 = run();
    const r2 = run();
    expect(r1).toEqual(r2);
    expect(Math.hypot(r1[2] - r1[0], r1[3] - r1[1])).toBeGreaterThanOrEqual(0.7 - 1e-6);
  });

  it("is order-independent: shuffled input, same outcome", () => {
    const mk = () => [disc("a", 0, 0), disc("b", 0.3, 0.1), disc("c", 0.15, -0.3)];
    const one = mk();
    const two = mk().reverse();
    for (let i = 0; i < 12; i++) {
      separateBodies(one);
      separateBodies(two);
    }
    for (const id of ["a", "b", "c"]) {
      const p = one.find((d) => d.id === id)!;
      const q = two.find((d) => d.id === id)!;
      expect(p.x).toBeCloseTo(q.x, 9);
      expect(p.z).toBeCloseTo(q.z, 9);
    }
  });
});

describe("steering avoidance", () => {
  it("deflects a head-on pair to opposite... same-side passing", () => {
    const a = disc("a", 0, 0, { vx: 1.2, vz: 0 });
    const b = disc("b", 2.2, 0, { vx: -1.2, vz: 0 });
    const va = avoidVelocity(a, [b], { vx: 1.2, vz: 0 });
    const vb = avoidVelocity(b, [a], { vx: -1.2, vz: 0 });
    // Both keep their speed; both gain a lateral component; and the
    // laterals are opposite (they pass side by side, not through).
    expect(Math.hypot(va.vx, va.vz)).toBeCloseTo(1.2, 5);
    expect(Math.abs(va.vz)).toBeGreaterThan(0.1);
    expect(Math.sign(va.vz)).toBe(-Math.sign(vb.vz));
  });

  it("leaves velocity alone when no encounter is predicted", () => {
    const a = disc("a", 0, 0, { vx: 1, vz: 0 });
    const far = disc("far", 0, 8, { vx: 0, vz: 0 });
    expect(avoidVelocity(a, [far], { vx: 1, vz: 0 })).toEqual({ vx: 1, vz: 0 });
    const standing = disc("s", 3, 3);
    expect(avoidVelocity(standing, [a], { vx: 0, vz: 0 })).toEqual({ vx: 0, vz: 0 });
  });
});
