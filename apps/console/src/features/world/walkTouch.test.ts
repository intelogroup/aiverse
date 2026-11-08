import { describe, expect, it } from "vitest";
import {
  LOOK_SENS,
  STICK_DEADZONE,
  STICK_RADIUS_PX,
  STICK_RUN_THRESHOLD,
  TouchWalkSource,
  classifyTouchGesture,
  doorChipClip,
  interactChipText,
  mergeTouchIntent,
  setLookPrefs,
  stickVector,
} from "./walkTouch";
import { TEA_DOOR_ORIGIN, teaStandPose } from "./teaDoor";
import type { WalkInput } from "./walker";
import type { InteractableDef } from "./interactables";

describe("classifyTouchGesture (the corpus ambiguity rule)", () => {
  it("a small, quick touch is a tap", () => {
    expect(classifyTouchGesture(0, 0, 40)).toBe("tap");
    expect(classifyTouchGesture(6, -7, 200)).toBe("tap");
  });
  it("movement past 10 px makes it a drag, at any speed", () => {
    expect(classifyTouchGesture(10, 0, 40)).toBe("drag");
    expect(classifyTouchGesture(-30, 40, 90)).toBe("drag");
  });
  it("a still touch held past ~250 ms is a drag, not a tap", () => {
    expect(classifyTouchGesture(2, 2, 250)).toBe("drag");
    expect(classifyTouchGesture(0, 0, 900)).toBe("drag");
  });
});

describe("stickVector", () => {
  it("centre and deadzone stand still", () => {
    expect(stickVector(0, 0)).toEqual({ forward: 0, strafe: 0, magnitude: 0 });
    const dz = STICK_RADIUS_PX * STICK_DEADZONE * 0.9;
    expect(stickVector(0, -dz).magnitude).toBe(0);
  });
  it("screen up is forward, screen right is strafe", () => {
    const up = stickVector(0, -STICK_RADIUS_PX);
    expect(up.forward).toBeCloseTo(1);
    expect(up.strafe).toBeCloseTo(0);
    const right = stickVector(STICK_RADIUS_PX, 0);
    expect(right.forward).toBeCloseTo(0);
    expect(right.strafe).toBeCloseTo(1);
    const back = stickVector(0, STICK_RADIUS_PX);
    expect(back.forward).toBeCloseTo(-1);
  });
  it("throw clamps at full and rescales out of the deadzone", () => {
    expect(stickVector(0, -STICK_RADIUS_PX * 3).magnitude).toBe(1);
    const half = stickVector(0, -STICK_RADIUS_PX * (STICK_DEADZONE + (1 - STICK_DEADZONE) / 2));
    expect(half.magnitude).toBeCloseTo(0.5);
    expect(half.forward).toBeCloseTo(0.5);
  });
  it("diagonals keep their direction", () => {
    const d = stickVector(STICK_RADIUS_PX, -STICK_RADIUS_PX);
    expect(d.magnitude).toBe(1);
    expect(d.forward).toBeCloseTo(Math.SQRT1_2);
    expect(d.strafe).toBeCloseTo(Math.SQRT1_2);
  });
});

describe("TouchWalkSource", () => {
  it("an idle source produces no intent and consumes empty look", () => {
    const s = new TouchWalkSource();
    expect(s.intent()).toEqual({ forward: 0, strafe: 0, run: false, active: false });
    expect(s.consumeLook()).toEqual({ yaw: 0, pitch: 0 });
  });
  it("the stick steers only while it is down", () => {
    const s = new TouchWalkSource();
    s.moveStick(0, -STICK_RADIUS_PX); // ignored: no touch-down yet
    expect(s.intent().active).toBe(false);
    s.beginStick();
    s.moveStick(0, -STICK_RADIUS_PX);
    expect(s.intent()).toMatchObject({ forward: 1, active: true });
    s.endStick();
    expect(s.intent()).toEqual({ forward: 0, strafe: 0, run: false, active: false });
  });
  it("push past the run threshold runs; the toggle chip latches run at any throw", () => {
    const s = new TouchWalkSource();
    s.beginStick();
    s.moveStick(0, -STICK_RADIUS_PX * (STICK_RUN_THRESHOLD - 0.05));
    expect(s.intent().run).toBe(false);
    s.moveStick(0, -STICK_RADIUS_PX * 0.95);
    expect(s.intent().run).toBe(true);
    s.moveStick(0, -STICK_RADIUS_PX * 0.4);
    expect(s.intent().run).toBe(false);
    s.runToggle = true;
    expect(s.intent().run).toBe(true);
  });
  it("look accumulates with touch signs (drag right = look right, drag up = look up) and consumes once", () => {
    const s = new TouchWalkSource();
    s.addLook(100, 0);
    s.addLook(0, -50);
    const l = s.consumeLook();
    expect(l.yaw).toBeGreaterThan(0);
    expect(l.pitch).toBeGreaterThan(0);
    expect(s.consumeLook()).toEqual({ yaw: 0, pitch: 0 });
  });
  it("reset forgets stick, toggle and look", () => {
    const s = new TouchWalkSource();
    s.beginStick();
    s.moveStick(0, -STICK_RADIUS_PX);
    s.runToggle = true;
    s.addLook(30, 30);
    s.reset();
    expect(s.intent()).toEqual({ forward: 0, strafe: 0, run: false, active: false });
    expect(s.runToggle).toBe(false);
    expect(s.consumeLook()).toEqual({ yaw: 0, pitch: 0 });
  });
});

describe("mergeTouchIntent", () => {
  const base: WalkInput = { forward: 0.5, strafe: -0.25, turn: 0, run: false, look: 0.1 };
  it("no source / idle source returns the base intent untouched (desktop bit-identical)", () => {
    expect(mergeTouchIntent(base, undefined)).toBe(base);
    expect(mergeTouchIntent(base, new TouchWalkSource())).toBe(base);
  });
  it("a down stick owns the move axes; run ORs in", () => {
    const s = new TouchWalkSource();
    s.beginStick();
    s.moveStick(STICK_RADIUS_PX, 0);
    const out = mergeTouchIntent(base, s);
    expect(out.forward).toBe(0);
    expect(out.strafe).toBe(1);
    expect(out.turn).toBe(0);
    expect(out.look).toBe(0.1);
  });
  it("the run toggle alone (no stick) still latches run without stealing axes", () => {
    const s = new TouchWalkSource();
    s.runToggle = true;
    const out = mergeTouchIntent(base, s);
    expect(out.run).toBe(true);
    expect(out.forward).toBe(0.5);
  });
});

describe("doorChipClip", () => {
  const street = teaStandPose("OpenDoorInwards");
  const inside = teaStandPose("OpenDoorOutwards");
  it("offers Inwards at the street stand pose, Outwards at the interior one", () => {
    expect(doorChipClip(street.x, street.z, "closed", "idle")).toBe("OpenDoorInwards");
    expect(doorChipClip(inside.x, inside.z, "closed", "idle")).toBe("OpenDoorOutwards");
  });
  it("no chip from across the plaza, deep inside, an open door, or mid-session", () => {
    expect(doorChipClip(0, 0, "closed", "idle")).toBeNull();
    expect(doorChipClip(street.x, TEA_DOOR_ORIGIN.z - 6, "closed", "idle")).toBeNull();
    expect(doorChipClip(street.x, street.z, "open", "idle")).toBeNull();
    expect(doorChipClip(street.x, street.z, "closed", "align")).toBeNull();
  });
  it("3 m inside the door plane is in range of the interior pose (Outwards)", () => {
    expect(doorChipClip(street.x, TEA_DOOR_ORIGIN.z - 3, "closed", "idle")).toBe("OpenDoorOutwards");
  });
});

describe("interactChipText", () => {
  const def = { label: "Radio" } as InteractableDef;
  it("speaks in human words, state included", () => {
    expect(interactChipText(def, false)).toBe("Turn radio on");
    expect(interactChipText(def, true)).toBe("Turn radio off");
  });
});

describe("look prefs (Phase 4)", () => {
  it("sensitivity scales and invert-Y flips the touch look", () => {
    const src = new TouchWalkSource();
    setLookPrefs({ sensitivity: 2, invertY: true });
    src.addLook(10, 4);
    const look = src.consumeLook();
    expect(look.yaw).toBeCloseTo(10 * LOOK_SENS * 2);
    expect(look.pitch).toBeCloseTo(4 * LOOK_SENS * 2); // inverted: drag down = pitch +
    setLookPrefs({ sensitivity: 1, invertY: false });
    src.addLook(10, 4);
    const look2 = src.consumeLook();
    expect(look2.yaw).toBeCloseTo(10 * LOOK_SENS);
    expect(look2.pitch).toBeCloseTo(-4 * LOOK_SENS);
  });
});
