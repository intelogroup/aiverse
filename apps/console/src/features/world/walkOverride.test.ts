import { describe, expect, it } from "vitest";
import { clipDef } from "./clips";
import { WalkClipOverride } from "./walkOverride";

const IN = "OpenDoorInwards";
const OUT = "OpenDoorOutwards";
const IN_S = clipDef(IN)!.duration;
const OUT_S = clipDef(OUT)!.duration;

describe("WalkClipOverride — the walk HUD clip machine", () => {
  it("starts clear: no forced clip, no toggle, no door", () => {
    const o = new WalkClipOverride();
    expect(o.current).toBeNull();
    expect(o.runHeld).toBe(false);
    expect(o.doorPlaying).toBe(false);
    expect(o.doorClip).toBeNull();
    expect(o.displayClip("walk")).toBe("walk");
  });

  it("run toggle on holds the Run loop regardless of elapsed time", () => {
    const o = new WalkClipOverride();
    o.toggleRun();
    expect(o.runHeld).toBe(true);
    expect(o.current).toBe("Run");
    o.tick(30); // loops never expire
    expect(o.current).toBe("Run");
    expect(o.displayClip("idle")).toBe("Run");
  });

  it("run toggle off hands the figure back to speed-driven clips", () => {
    const o = new WalkClipOverride();
    o.toggleRun();
    o.toggleRun();
    expect(o.runHeld).toBe(false);
    expect(o.current).toBeNull();
    expect(o.displayClip("idle")).toBe("idle");
  });

  it("a door one-shot plays for exactly its catalog duration, then expires to speed state", () => {
    const o = new WalkClipOverride();
    expect(o.fireDoor(IN)).toBe(true);
    expect(o.current).toBe(IN);
    expect(o.doorPlaying).toBe(true);
    o.tick(IN_S - 0.01);
    expect(o.current).toBe(IN);
    expect(o.doorPlaying).toBe(true);
    o.tick(0.02);
    expect(o.current).toBeNull();
    expect(o.doorPlaying).toBe(false);
    expect(o.displayClip("walk")).toBe("walk");
  });

  it("the latest door press wins: a second one-shot replaces the first and restarts its clock", () => {
    const o = new WalkClipOverride();
    o.fireDoor(IN);
    o.tick(IN_S - 0.5); // nearly out of the inwards shot
    expect(o.fireDoor(OUT)).toBe(true);
    expect(o.current).toBe(OUT);
    expect(o.doorClip).toBe(OUT);
    o.tick(OUT_S - 0.01); // would have long expired under the old clock
    expect(o.current).toBe(OUT);
    o.tick(0.02);
    expect(o.current).toBeNull();
  });

  it("fireDoor refuses anything that is not a door one-shot", () => {
    const o = new WalkClipOverride();
    expect(o.fireDoor("Run")).toBe(false);
    expect(o.fireDoor("Moonwalk")).toBe(false);
    expect(o.current).toBeNull();
    expect(o.doorPlaying).toBe(false);
  });

  it("a door one-shot fired over a held Run plays, then Run resumes at expiry", () => {
    const o = new WalkClipOverride();
    o.toggleRun();
    expect(o.fireDoor(OUT)).toBe(true);
    expect(o.current).toBe(OUT);
    o.tick(OUT_S + 0.01);
    expect(o.current).toBe("Run");
    expect(o.doorPlaying).toBe(false);
    expect(o.runHeld).toBe(true);
  });

  it("toggling Run during a door one-shot defers to expiry: on resumes Run, off returns to speed", () => {
    const on = new WalkClipOverride();
    on.fireDoor(IN);
    on.toggleRun(); // door keeps the stage
    expect(on.current).toBe(IN);
    on.tick(IN_S + 0.01);
    expect(on.current).toBe("Run");

    const off = new WalkClipOverride();
    off.toggleRun();
    off.fireDoor(IN);
    off.toggleRun(); // un-hold Run mid-shot
    expect(off.current).toBe(IN);
    off.tick(IN_S + 0.01);
    expect(off.current).toBeNull();
    expect(off.runHeld).toBe(false);
  });
});
