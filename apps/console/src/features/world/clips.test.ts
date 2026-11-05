import { describe, expect, it } from "vitest";
import { CLIP_BY_NAME, CLIP_CATALOG, ClipTestState, clipDef } from "./clips";

describe("clip catalog", () => {
  it("carries 45 clips with unique names", () => {
    expect(CLIP_CATALOG).toHaveLength(45);
    expect(new Set(CLIP_CATALOG.map((c) => c.name)).size).toBe(45);
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
