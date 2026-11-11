import { describe, expect, it } from "vitest";
import { BODIES } from "./bodies";
import { CLIP_BY_NAME, CLIP_CATALOG, ClipTestState, clipDef, clipTesterYield } from "./clips";

describe("clip catalog", () => {
  it("carries 53 clips with unique names", () => {
    expect(CLIP_CATALOG).toHaveLength(53);
    expect(new Set(CLIP_CATALOG.map((c) => c.name)).size).toBe(53);
    for (const c of CLIP_CATALOG) {
      expect(CLIP_BY_NAME.get(c.name)).toBe(c);
      expect(c.duration).toBeGreaterThan(0);
    }
  });

  it("keeps the five core clips the body layer is wired to", () => {
    expect(clipDef("Idle")).toMatchObject({ loop: true, duration: 2.6667 });
    expect(clipDef("Walk")).toMatchObject({ loop: true, duration: 1.1667 });
    expect(clipDef("SittingTalking")).toMatchObject({ loop: true, duration: 44.1 });
    expect(clipDef("SitDown")).toMatchObject({ loop: false, duration: 2.2333 });
    expect(clipDef("StandUp")).toMatchObject({ loop: false, duration: 2.2667 });
  });

  it("classifies the batch: seated idle and talk cycles loop, gestures play once", () => {
    expect(clipDef("SittingIdle")?.loop).toBe(true);
    expect(clipDef("Talking")?.loop).toBe(true);
    expect(clipDef("Clapping")?.loop).toBe(true);
    expect(clipDef("Run")?.loop).toBe(true);
    expect(clipDef("Waving")?.loop).toBe(false);
    expect(clipDef("Handshake1")?.loop).toBe(false);
    expect(clipDef("Death")?.loop).toBe(false);
    expect(clipDef("EnterCar")?.loop).toBe(false);
    // 2026-11-09 additions: the dance and the tablet activity hold; the rest play once.
    expect(clipDef("SillyDancing")?.loop).toBe(true);
    expect(clipDef("StandingUsingTouchscreenTablet")?.loop).toBe(true);
    expect(clipDef("Defeated")?.loop).toBe(false);
    expect(clipDef("HoldingTurnLeft")?.loop).toBe(false);
    expect(clipDef("PullingLever")?.loop).toBe(false);
    expect(clipDef("TenderPlacement")?.loop).toBe(false);
    expect(clipDef("PuttingDown")?.loop).toBe(false);
    // 2026-11-10 addition: the code-entry cycle holds (its source pose closes exactly).
    expect(clipDef("EnteringCode")?.loop).toBe(true);
  });
});

describe("ClipTestState — the panel tester machine", () => {
  it("refuses an unknown clip and stays idle", () => {
    const t = new ClipTestState();
    expect(t.fire("Moonwalk")).toBe(false);
    expect(t.current).toBeNull();
  });

  it("holds a loop until another choice", () => {
    const t = new ClipTestState();
    expect(t.fire("SittingIdle")).toBe(true);
    t.tick(60);
    expect(t.current).toBe("SittingIdle");
    expect(t.fire("Talking")).toBe(true);
    expect(t.current).toBe("Talking");
  });

  it("plays a one-shot once and expires back to Idle", () => {
    const t = new ClipTestState();
    t.fire("Waving"); // 0.5333 s
    t.tick(0.5);
    expect(t.current).toBe("Waving");
    t.tick(0.1);
    expect(t.current).toBeNull();
  });

  it("restarts the one-shot clock when a new clip is fired mid-play", () => {
    const t = new ClipTestState();
    t.fire("Waving");
    t.tick(0.5);
    t.fire("Bow"); // 2.7333 s — the wave's clock must not leak into it
    t.tick(0.5);
    expect(t.current).toBe("Bow");
    t.tick(2.3);
    expect(t.current).toBeNull();
  });

  it("firing Idle hands the body back to the body layer", () => {
    const t = new ClipTestState();
    t.fire("Victory");
    expect(t.fire("Idle")).toBe(true);
    expect(t.current).toBeNull();
  });
});

describe("clipTesterYield — the tester/body-layer yield", () => {
  // The regression (2026-11-10): firing a body's resting clip from
  // the clip tester damped the body-layer idle to zero while the
  // tester created no overlay for it — the figure froze. Every body
  // in the registry pins the exemption for its own clip names.
  for (const body of Object.values(BODIES)) {
    it(`${body.id}: firing its resting clip (${body.clips.idle}) never yields the body layer`, () => {
      expect(clipTesterYield(body.clips.idle, body.clips.walk, body.clips.idle, 1)).toBe(0);
      expect(clipTesterYield(body.clips.idle, body.clips.walk, body.clips.idle, 0.85)).toBe(0);
    });

    it(`${body.id}: firing Walk never yields the body layer`, () => {
      expect(clipTesterYield(body.clips.walk, body.clips.walk, body.clips.idle, 1)).toBe(0);
    });
  }

  it("a regular catalog clip yields the body layer by the full tester weight", () => {
    const body = Object.values(BODIES)[0];
    expect(clipTesterYield("Clapping", body.clips.walk, body.clips.idle, 0.85)).toBe(0.85);
    expect(clipTesterYield("Clapping", body.clips.walk, body.clips.idle, 1)).toBe(1);
    expect(clipTesterYield("Clapping", body.clips.walk, body.clips.idle, 0)).toBe(0);
  });

  it("no fired clip means no yield beyond the (zero) tester weight", () => {
    const body = Object.values(BODIES)[0];
    expect(clipTesterYield(null, body.clips.walk, body.clips.idle, 0)).toBe(0);
  });
});
