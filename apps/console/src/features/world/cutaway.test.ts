import { describe, expect, it } from "vitest";
import { boxPlanes, inactivePlanes, isClipped, pickCutRoom, type CutRoom } from "./cutaway";

const box = { rect: [-37.5, -84.5, -12.5, -72.5] as [number, number, number, number], y: 4.45 };

describe("boxPlanes / isClipped", () => {
  const planes = boxPlanes(box);
  it("clips points inside the box above the ceiling line", () => {
    expect(isClipped({ x: -25, y: 10, z: -78 }, planes)).toBe(true); // upper floor
    expect(isClipped({ x: -25, y: 20, z: -78 }, planes)).toBe(true); // roof
  });
  it("keeps the ground floor, and everything outside the footprint", () => {
    expect(isClipped({ x: -25, y: 2, z: -78 }, planes)).toBe(false); // the furnished room
    expect(isClipped({ x: -10, y: 10, z: -78 }, planes)).toBe(false); // neighbour to the east
    expect(isClipped({ x: -25, y: 10, z: -70 }, planes)).toBe(false); // street side
    expect(isClipped({ x: -25, y: 10 + 100, z: -78 }, planes)).toBe(false); // above the cut volume
  });
  it("inactive planes clip nothing, anywhere", () => {
    const off = inactivePlanes();
    for (const p of [{ x: 0, y: 0, z: 0 }, { x: -25, y: 10, z: -78 }, { x: 500, y: 90, z: -500 }]) expect(isClipped(p, off)).toBe(false);
  });
});

const room = (id: string, x: number): CutRoom => ({
  id,
  center: [x, 0],
  rect: [x - 6, -6, x + 6, 6],
  cut: box,
});
const rooms: CutRoom[] = [room("a", 0), room("b", 12), room("c", 200)];
describe("pickCutRoom", () => {
  const at = (x: number, z = 0) => ({ x, z });
  it("opens the room under the camera target once zoomed in, none when zoomed out or off-building", () => {
    expect(pickCutRoom(rooms, at(2), 30, null, 48, 60)).toBe("a");
    expect(pickCutRoom(rooms, at(14), 30, null, 48, 60)).toBe("b");
    expect(pickCutRoom(rooms, at(2), 80, null, 48, 60)).toBeNull(); // too far out
    expect(pickCutRoom(rooms, at(100), 30, null, 48, 60)).toBeNull(); // nothing under the target
  });
  it("is decided by the target, not by where the camera stands", () => {
    // the camera may be nearer to b's centre in the street, but it is looking at a
    expect(pickCutRoom(rooms, at(-2), 30, null, 48, 60)).toBe("a");
  });
  it("keeps the open room between the radii, while the target stays near it", () => {
    expect(pickCutRoom(rooms, at(2), 55, "a", 48, 60)).toBe("a");
    expect(pickCutRoom(rooms, at(2), 55, null, 48, 60)).toBeNull(); // not opened from scratch there
    expect(pickCutRoom(rooms, at(2), 70, "a", 48, 60)).toBeNull(); // past the show radius
  });
  it("lets go of a room once the target has moved well away, and does not hop on a small pan", () => {
    expect(pickCutRoom(rooms, at(8), 30, "a", 48, 60)).toBe("a"); // 2 m past a's edge, still within slack
    expect(pickCutRoom(rooms, at(150), 30, "a", 48, 60)).toBeNull();
  });
});
