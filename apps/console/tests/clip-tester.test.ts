// @vitest-environment node
// Source-level checks for the CastFigure clip-tester overlay: no
// renderer in the test env, so these assert the shipped source
// carries the contract — a figure ticks the shared ClipTestState it
// was handed (the walk HUD, the keeper, the bartender and Scout all
// drive figures this way) and blends toward it, and the sit
// choreography's guards (suppression under a sit override, sit
// drivers never stopping the tester's action) are present. Behavior
// of the state machine itself is unit-tested in
// src/features/world/clips.test.ts. (The Embody panel that first
// wired a tester into GlbWorld was deleted with the Agora,
// 2026-11-08.) Lives outside src/ like the other source checks
// (browser-typed tsconfig in there).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const figure = readFileSync(new URL("../src/features/world/CastFigure.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/features/world/world.css", import.meta.url), "utf8");

describe("clip tester — walk panel", () => {
  it("the clip list scrolls inside the panel", () => {
    expect(css).toContain(".w-clip-list");
    expect(css).toContain("overflow-y: auto");
  });
});

describe("clip tester — figure overlay", () => {
  it("the figure ticks the tester state and syncs to its current clip", () => {
    expect(figure).toContain("clipTester.tick(delta)");
    expect(figure).toContain("clipTester.current !== activeTest.current");
    expect(figure).toContain("byName.get(want)");
  });

  it("one-shots clamp at their final pose, loops repeat", () => {
    expect(figure).toContain("THREE.LoopOnce, 1");
    expect(figure).toContain("a.clampWhenFinished = true");
    expect(figure).toContain("THREE.LoopRepeat, Infinity");
  });

  it("the sit choreography is never fought: sync skips under an override, sit drivers never stop the tester's action", () => {
    expect(figure).toContain("if (!ov && clipTester.current !== activeTest.current)");
    expect(figure).toContain("action !== testActionRef.current");
    expect(figure).toContain("sit !== testActionRef.current");
    expect(figure).toContain("activeTest.current && !ov ? 1 : 0");
  });

  it("the upright clips yield to the tester by the same factor", () => {
    expect(figure).toContain("(1 - yieldEff)");
    expect(figure).toContain("testerWalk");
  });
});
