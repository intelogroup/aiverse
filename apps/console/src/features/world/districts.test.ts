import { describe, expect, it } from "vitest";
import { EVICT_GRACE_MS, RESIDENT_COLLISION_URL, blendTheme, collisionJobs, dueEvictions, isShellCovered, planDistricts, residentCollisionUrl, rectDistance, themeDelta, type DistrictDef, type DistrictManifest, type Theme } from "./districts";

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
    // Streaming policy (2026-11-08): from the Bazaar centre every neighbour is
    // 220 m away — beyond the 90 m load radius, so spawn loads nothing extra.
    expect(planDistricts([0, 0], defs, new Set()).load).toEqual([]);
    // 60 m from n's edge: only n streams in.
    expect(planDistricts([0, -160], defs, new Set()).load).toEqual(["n"]);
    // The cap still applies when several districts are in range at once.
    expect(planDistricts([0, 0], defs, new Set(), { loadR: 330 }).load.length).toBe(3);
    expect(planDistricts([0, 0], defs, new Set(), { loadR: 330, cap: 2 }).load.length).toBe(2);
    expect(planDistricts([0, -160], defs, new Set()).load).not.toContain("bazaar");
  });
  it("lookahead prefetches toward movement but never keeps", () => {
    // Standing at the centre, heading north: n (edge 220 m away) prefetches.
    expect(planDistricts([0, 0], defs, new Set(), { ahead: [0, -300] }).load).toEqual(["n"]);
    // But a district only inside the lookahead still unloads on the true focus.
    const p = planDistricts([0, 0], defs, new Set(["e"]), { keepR: 100, ahead: [400, 0] });
    expect(p.unload).toEqual(["e"]);
  });
  it("eviction grace: an unload is due only after the grace has elapsed", () => {
    const since = new Map([["n", 1_000]]);
    expect(dueEvictions(["n"], since, 1_000 + EVICT_GRACE_MS - 1)).toEqual([]);
    expect(dueEvictions(["n"], since, 1_000 + EVICT_GRACE_MS)).toEqual(["n"]);
    expect(dueEvictions(["n"], new Map(), 10 * EVICT_GRACE_MS)).toEqual([]); // no stamp: not yet due
  });
  it("hysteresis: keeps a loaded district until beyond keepR", () => {
    const mid = planDistricts([0, -400 + 180 + 250], defs, new Set(["n"])); // 250 m from n's edge: inside keep
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

describe("far-shell coverage", () => {
  it("a streamed district is covered once its detail is in the loaded set", () => {
    expect(isShellCovered("n", new Set(["n"]), "bazaar", false)).toBe(true);
    expect(isShellCovered("n", new Set(), "bazaar", true)).toBe(false); // resident readiness never covers a streamed district
    expect(isShellCovered("n", new Set(["e"]), "bazaar", false)).toBe(false);
  });
  it("the resident is covered once mounted, though it never enters the streamed set", () => {
    // Regression (Phase 3 screenshot proof, 2026-11-09): keying coverage on the streamed set alone
    // left shell:bazaar visible forever, carpeting the plaza with massing boxes over the resident.
    expect(isShellCovered("bazaar", new Set(), "bazaar", true)).toBe(true);
    expect(isShellCovered("bazaar", new Set(), "bazaar", false)).toBe(false); // before mount the shell must stay up: no hole
  });
  it("no resident declared (or a different one) never covers", () => {
    expect(isShellCovered("bazaar", new Set(), undefined, true)).toBe(false);
    expect(isShellCovered("bazaar", new Set(), "n", true)).toBe(false);
  });
});

describe("district collision urls", () => {
  const withCol: DistrictDef[] = defs.map((d) => (d.id === "bazaar" || d.id === "n" || d.id === "e" ? { ...d, collisionUrl: `/c/${d.id}.glb` } : d));
  it("jobs follow the plan: only districts being loaded, only those that declare a collisionUrl", () => {
    const p = planDistricts([160, -160], withCol, new Set()); // 60 m from both n's and e's edges
    expect(p.load).toEqual(["n", "e"]);
    expect([...collisionJobs(p.load, withCol)]).toEqual([["n", "/c/n.glb"], ["e", "/c/e.glb"]]); // w and s have none
    expect(collisionJobs(["bazaar", "nope"], withCol).get("bazaar")).toBe("/c/bazaar.glb");
  });
  it("evicted districts have nothing to load; the resident url falls back to the default", () => {
    const p = planDistricts([3000, 3000], withCol, new Set(["n"]));
    expect(p.unload).toEqual(["n"]);
    expect(collisionJobs(p.load, withCol).size).toBe(0);
    expect(residentCollisionUrl(withCol)).toBe("/c/bazaar.glb");
    expect(residentCollisionUrl(defs)).toBe(RESIDENT_COLLISION_URL);
  });
});
