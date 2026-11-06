// @vitest-environment node
// Source-level checks for the Embody panel clip tester (catalog wave):
// no renderer in the test env, so these assert the shipped source
// carries the wiring contract — the panel lists every catalog clip
// and fires it into the shared ClipTestState, the focus figure ticks
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

  it("one shared ClipTestState reaches the panel and the focus figure only", () => {
    expect(world).toContain("new ClipTestState()");
    expect(world).toContain("clipTester={i === focusIndex ? clipTester : undefined}");
    expect(world).toContain("clipTester={clipTesterRef.current}");
  });

  it("the tester can step the catalog in order, not only click the list", () => {
    expect(world).toContain("stepClip(-1)");
    expect(world).toContain("stepClip(1)");
    expect(world).toContain("CLIP_CATALOG[next].name");
    expect(world).toContain("clip ${clipIdx + 1} / ${CLIP_CATALOG.length}");
  });

  it("the clip list scrolls inside the panel", () => {
    expect(css).toContain(".w-clip-list");
    expect(css).toContain("overflow-y: auto");
  });
});

describe("summer camera — focus wiring", () => {
  it("the focus defaults to the member wearing Summer's body", () => {
    expect(world).toContain("bodyForMember(m) === BODY_SUMMER");
    expect(world).toContain('aria-label="Focus member"');
    expect(world).toContain("onFocus(m.id)");
  });

  it("the camera rig rides the focus figure and hides it in ride mode", () => {
    expect(world).toContain("index={focusIndex}");
    expect(world).toContain("hidden={embodyOn && i === focusIndex && camMode === \"ride\"}");
  });

  it("ride anchors on the focus figure's streamed head bone when it lands", () => {
    expect(world).toContain("rideTargetFromHead(headPos, heading)");
    expect(world).toContain("headPoseRef={i === focusIndex ? headPoseRef : undefined}");
    expect(figure).toContain('o.name.endsWith("Head")');
    expect(figure).toContain("headBone.getWorldPosition(hw)");
  });

  it("a live render-fps readout shows while a bot camera mode is active", () => {
    expect(world).toContain("FpsTracker");
    expect(world).toContain("fpsMeter.fps().toFixed(0)");
    expect(world).toContain("meterRef.current?.push(state.clock.elapsedTime * 1000)");
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
