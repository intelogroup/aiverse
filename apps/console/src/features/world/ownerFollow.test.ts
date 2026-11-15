import { describe, expect, it } from "vitest";
import { FOLLOW_BACK, FOLLOW_UP } from "./cameraRig";
import { ownFollowPose, pickOwnBody } from "./ownerFollow";

const roster = [
  { n: 1, name: "Mira" },
  { n: 4, name: "Seeker" },
  { n: 7, name: "Ada" },
  { n: 9, name: "Seeker-2" },
];

describe("pickOwnBody", () => {
  it("returns null with no owner agents (a visitor) or no matching body", () => {
    expect(pickOwnBody(roster, [])).toBeNull();
    expect(pickOwnBody(roster, ["Nobody"])).toBeNull();
    expect(pickOwnBody([], ["Seeker"])).toBeNull();
  });
  it("matches by exact name", () => {
    expect(pickOwnBody(roster, ["Seeker"])?.n).toBe(4);
    expect(pickOwnBody(roster, ["seeker"])).toBeNull();
  });
  it("takes the newest attached body when several of the owner's agents are in the world", () => {
    expect(pickOwnBody(roster, ["Seeker", "Ada", "Seeker-2"])?.n).toBe(9);
    expect(pickOwnBody(roster, ["Seeker", "Ada"])?.n).toBe(7);
  });
});

describe("ownFollowPose", () => {
  it("puts the camera behind the body, above its feet, looking at its chest", () => {
    // heading 0 faces +z, so behind is -z
    const { cam, look } = ownFollowPose({ x: 10, y: 0.5, z: 20, heading: 0 });
    expect(cam[0]).toBeCloseTo(10);
    expect(cam[1]).toBeCloseTo(0.5 + FOLLOW_UP);
    expect(cam[2]).toBeCloseTo(20 - FOLLOW_BACK);
    expect(look[0]).toBeCloseTo(10);
    expect(look[2]).toBeCloseTo(20);
    expect(look[1]).toBeGreaterThan(0.5);
  });
  it("follows the heading (facing +x puts the camera at -x)", () => {
    const { cam } = ownFollowPose({ x: 0, y: 0, z: 0, heading: Math.PI / 2 });
    expect(cam[0]).toBeCloseTo(-FOLLOW_BACK);
    expect(cam[2]).toBeCloseTo(0, 5);
  });
});
