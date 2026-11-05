// @vitest-environment node
// Pure math only — same header discipline as the sibling suites.

import { describe, expect, it } from "vitest";
import {
  EYE_FORWARD,
  FOLLOW_BACK,
  damp,
  dampAngle,
  dampFactor,
  followTarget,
  rideTarget,
  botView,
} from "./cameraRig";
import type { FigureOverride } from "./embody";
import type { AgentFrame } from "./locomotion";

const frame = (position: [number, number], heading: number): AgentFrame => ({
  position,
  velocity: [0, 0],
  speed: 0,
  heading,
  state: "idle",
  targetsReached: 0,
});

describe("dampers", () => {
  it("dampFactor is 0 at dt 0 and approaches 1 for long steps", () => {
    expect(dampFactor(5, 0)).toBe(0);
    expect(dampFactor(5, 2)).toBeGreaterThan(0.999);
  });

  it("damp converges on the target and holds at dt 0", () => {
    expect(damp(2, 5, 5, 0)).toBe(2);
    let v = 0;
    for (let i = 0; i < 120; i++) v = damp(v, 10, 5, 1 / 60);
    expect(v).toBeCloseTo(10, 3);
  });

  it("dampAngle turns the short way across the ±PI seam", () => {
    // From 170° to -170° the short way is +20° through PI, not -340°.
    const v = dampAngle((170 * Math.PI) / 180, (-170 * Math.PI) / 180, 1e6, 1);
    expect(v).toBeCloseTo((-170 * Math.PI) / 180);
    // A partial step moves toward PI (increasing), not away from it.
    const partial = dampAngle((170 * Math.PI) / 180, (-170 * Math.PI) / 180, 2, 0.1);
    expect(partial).toBeGreaterThan((170 * Math.PI) / 180);
  });

  it("dampAngle stays normalized in (-PI, PI]", () => {
    let v = 0;
    for (let i = 0; i < 600; i++) v = dampAngle(v, v + 0.7, 3, 1 / 60);
    expect(v).toBeGreaterThan(-Math.PI);
    expect(v).toBeLessThanOrEqual(Math.PI);
  });
});

describe("botView", () => {
  it("is null with neither frame nor override", () => {
    expect(botView(null, null, 0.84)).toBeNull();
  });

  it("standing: feet on the ground plane, heading from the frame", () => {
    const v = botView(frame([2, 3], 0.5), null, 0.84)!;
    expect(v).toMatchObject({ x: 2, z: 3, heading: 0.5, feetY: 0.84, seated: false });
  });

  it("override wins over the crowd frame: seat position, lift, anchor facing", () => {
    const ov: FigureOverride = { position: [-4, 1], y: 0.45, heading: 2.2, phase: "seated" };
    const v = botView(frame([9, 9], 0), ov, 0.84)!;
    expect(v).toMatchObject({ x: -4, z: 1, heading: 2.2, seated: true });
    expect(v.feetY).toBeCloseTo(0.84 + 0.45);
  });
});

describe("rideTarget", () => {
  it("standing: camera at the eyes (face plane), gaze level and 4 m along the heading", () => {
    const v = botView(frame([1, 2], Math.PI / 2), null, 0.84)!; // facing +X
    const { cam, look } = rideTarget(v, v.heading);
    expect(cam[0]).toBeCloseTo(1 + EYE_FORWARD); // pushed out of the head shell
    expect(cam[1]).toBeCloseTo(0.84 + 1.15);
    expect(cam[2]).toBeCloseTo(2);
    expect(look[0]).toBeCloseTo(cam[0] + 4);
    expect(look[1]).toBeCloseTo(cam[1]); // level gaze, no pitch
    expect(look[2]).toBeCloseTo(2);
  });

  it("seated: camera rides at seat height + the seated head offset", () => {
    const ov: FigureOverride = { position: [0, 5.2], y: 0.45, heading: Math.PI, phase: "seated" };
    const v = botView(null, ov, 0.84)!;
    const { cam, look } = rideTarget(v, v.heading);
    expect(cam[1]).toBeCloseTo(0.84 + 0.45 + 1.0);
    // Facing PI looks toward -Z from the seat.
    expect(look[2]).toBeLessThan(cam[2]);
  });
});

describe("followTarget", () => {
  it("trails behind the heading and aims at the chest", () => {
    const v = botView(frame([0, 0], 0), null, 0.84)!; // facing +Z
    const { cam, look } = followTarget(v);
    expect(cam[0]).toBeCloseTo(0);
    expect(cam[1]).toBeCloseTo(0.84 + 1.9);
    expect(cam[2]).toBeCloseTo(-FOLLOW_BACK);
    expect(look).toEqual([0, 0.84 + 0.9, 0]);
  });
});
