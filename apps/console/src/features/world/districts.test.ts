import { describe, expect, it } from "vitest";
import { blendTheme, planDistricts, rectDistance, themeDelta, type DistrictDef, type DistrictManifest, type Theme } from "./districts";

const th = (r: number, night = 0): Theme => ({ skyTop: [r, 0, 0], skyHorizon: [r, 0, 0], fog: [r, 0, 0], fogDensity: 0.001, water: [0, 0, 0], sun: [1, 1, 1],
  sunIntensity: 2, sunDir: [0, 1, 0], ambient: 0.1, envIntensity: 0.5, exposure: 1, night });
const defs: DistrictDef[] = [
  { id: "bazaar", name: "B", url: "b", center: [0, 0], half: 180, theme: "a", resident: true },
  { id: "n", name: "N", url: "n", center: [0, -400], half: 180, theme: "b" },
  { id: "e", name: "E", url: "e", center: [400, 0], half: 180, theme: "a" },
  { id: "w", name: "W", url: "w", center: [-400, 0], half: 180, theme: "a" },
  { id: "s", name: "S", url: "s", center: [0, 400], half: 180, theme: "a" },
];
describe("districts", () => {
  it("rectDistance is 0 inside and euclidean outside", () => {
    expect(rectDistance(10, 10, defs[0])).toBe(0);
    expect(rectDistance(0, -220, defs[1])).toBe(0);
    expect(rectDistance(0, 0, defs[1])).toBeCloseTo(220, 5);
    expect(rectDistance(220, 220, defs[0])).toBeCloseTo(Math.hypot(40, 40), 5);
  });
  it("loads only near districts, never residents, nearest first", () => {
    const p = planDistricts([0, 0], defs, new Set());
    expect(p.load).toEqual(["n", "e", "w", "s"]); // all four neighbours are 220 m away: none may be dropped
    expect(planDistricts([0, 0], defs, new Set(), { cap: 3 }).load.length).toBe(3); // cap still applies
    expect(p.load).not.toContain("bazaar");
  });
  it("hysteresis: keeps a loaded district until beyond keepR", () => {
    const mid = planDistricts([0, -400 + 180 + 450], defs, new Set(["n"])); // 450 m from n's edge: inside keep
    expect(mid.unload).not.toContain("n");
    const far = planDistricts([0, 800], defs, new Set(["n"]));
    expect(far.unload).toContain("n");
  });
  it("never unloads the resident", () => {
    expect(planDistricts([5000, 5000], defs, new Set(["bazaar"])).unload).toEqual([]);
  });
  it("far from everything loads nothing", () => { expect(planDistricts([3000, 3000], defs, new Set()).load).toEqual([]); });
  it("blendTheme is pure inside a district, mixes in the gap", () => {
    const m: DistrictManifest = { districts: defs, themes: { a: th(0), b: th(1, 1) } };
    expect(blendTheme([0, 0], m).skyTop[0]).toBeCloseTo(0, 5);
    expect(blendTheme([0, -400], m).night).toBeCloseTo(1, 5);
    const gap = blendTheme([0, -200], m); // 20 m from both edges
    expect(gap.night).toBeGreaterThan(0.3); expect(gap.night).toBeLessThan(0.7);
  });
  it("themeDelta", () => { expect(themeDelta(th(0), th(0))).toBe(0); expect(themeDelta(th(0), th(0.5))).toBeCloseTo(0.5, 5); });
});
