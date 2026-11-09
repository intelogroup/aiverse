import { describe, expect, it } from "vitest";
import { TEA_FLOORS, inTeaBuilding, teaEntranceView } from "./teaBuilding";

// The shipped tea room from the city3 room index: graded main entrance on the
// street frontage (z=-72.5), interior floor 0.48 (TEA_FLOORS[0]).
const teaRoom = {
  door: [-22.92, -72.5] as [number, number],
  front: "S" as const,
  center: [-25, -78.5] as [number, number],
};

describe("teaEntranceView", () => {
  it("stands just inside the main entrance at standing eye height", () => {
    const v = teaEntranceView(teaRoom);
    expect(v.position[0]).toBeCloseTo(-22.92, 2); // on the door's line
    expect(v.position[1]).toBeCloseTo(TEA_FLOORS[0].y + 1.6, 5); // eye height
    expect(v.position[2]).toBeLessThan(-72.5); // inside, not on the street
    expect(inTeaBuilding(v.position[0], v.position[2])).toBe(true);
  });

  it("looks across the room, essentially level — never pitched down at the floor", () => {
    const v = teaEntranceView(teaRoom);
    const dx = v.target[0] - v.position[0];
    const dz = v.target[2] - v.position[2];
    const dy = v.target[1] - v.position[1];
    const horizontal = Math.hypot(dx, dz);
    expect(horizontal).toBeGreaterThan(5); // a real look across the room
    const pitchDeg = (Math.atan2(-dy, horizontal) * 180) / Math.PI;
    expect(pitchDeg).toBeGreaterThan(-2); // does not tilt up
    expect(pitchDeg).toBeLessThan(10); // and never face-down (the old preset sat ~29° down from 15 m up)
    expect(inTeaBuilding(v.target[0], v.target[2])).toBe(true);
  });
});
