// @vitest-environment node
// Source-level checks for the Embody panel clip tester (catalog wave):
// no renderer in the test env, so these assert the shipped source
// carries the wiring contract — the panel lists every catalog clip
// and fires it into the shared ClipTestState, cast[0]'s figure ticks
// that state and blends toward it, and the sit choreography's guards
// (suppression under a sit override, sit drivers never stopping the
// tester's action) are present. Behavior of the state machine itself
// is unit-tested in src/features/world/clips.test.ts. Lives outside
// src/ like the other source checks (browser-typed tsconfig in there).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const world = readFileSync(new URL("../src/features/world/GlbWorld.tsx", import.meta.url), "utf8");
const figure = readFileSync(new URL("../src/features/world/CastFigure.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/features/world/world.css", import.meta.url), "utf8");

describe("clip tester — panel wiring", () => {
  it("the panel lists every catalog clip and fires it into the tester state", () => {
    expect(world).toContain("Clip tester");
    expect(world).toContain("CLIP_CATALOG.map");
    expect(world).toContain("clipTester.fire(c.name)");
    expect(world).toContain('aria-label="Clip tester"');
  });

  it("one shared ClipTestState reaches the panel and cast[0]'s figure only", () => {
    expect(world).toContain("new ClipTestState()");
    expect(world).toContain("clipTester={i === 0 ? clipTester : undefined}");
    expect(world).toContain("clipTester={clipTesterRef.current}");
  });

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
