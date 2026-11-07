// @vitest-environment node
import { describe, expect, it } from "vitest";
import { makeWalkWorld, newWalkerFrame, writeWalkerFrame } from "./walkerBody";
import { makeWalker } from "./walker";
import type { WalkColliders } from "./walkColliders";

describe("writeWalkerFrame", () => {
  it("copies position, velocity, speed, BODY heading, clip and backpedal into the same frame object", () => {
    const s = makeWalker(3, 0.2, -4, 1.0);
    s.vx = 0.5; s.vz = -1.2; s.speed = 1.3; s.body = 0.7; s.heading = 1.0; s.backward = true;
    const f = newWalkerFrame();
    const out = writeWalkerFrame(f, s);
    expect(out).toBe(f);
    expect(f.position).toEqual([3, -4]);
    expect(f.velocity).toEqual([0.5, -1.2]);
    expect(f.speed).toBe(1.3);
    expect(f.heading).toBe(0.7); // body, not the view heading
    expect(f.state).toBe("walk");
    expect(f.gait?.reverse).toBe(true);
  });

  it("a pose override (seated) wins: its place and facing, standing still", () => {
    const s = makeWalker(3, 0.2, -4, 1.0);
    s.speed = 1.3;
    const f = writeWalkerFrame(newWalkerFrame(), s, { x: 9, z: 8, heading: 2 });
    expect(f.position).toEqual([9, 8]);
    expect(f.heading).toBe(2);
    expect(f.speed).toBe(0);
    expect(f.state).toBe("idle");
  });
});

describe("makeWalkWorld", () => {
  it("reports raycast without a collider list, and follows the collision status otherwise", () => {
    expect(makeWalkWorld(() => []).kind()).toBe("raycast");
    const walk = { status: "loading", list: [] } as unknown as WalkColliders;
    const w = makeWalkWorld(() => [], walk);
    expect(w.kind()).toBe("pending");
    (walk as { status: string }).status = "ready";
    expect(w.kind()).toBe("capsule");
    (walk as { status: string }).status = "failed";
    expect(w.kind()).toBe("raycast");
  });
});
