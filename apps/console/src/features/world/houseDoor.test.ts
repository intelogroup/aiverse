import { expect, it } from "vitest";
import { doorBox, doorHinge, doorLocal, HouseDoor, slidePanels, type DoorLeafSpec } from "./houseDoor";
import { boxesMesh, createCapsuleWorld } from "./capsuleWorld";

// Scandi Hawk's surveyed door: the first spec, unchanged behaviour from the old HawkDoor.
const HAWK: DoorLeafSpec = { x: 22.925, y: 0.53, z: -142.086, width: 1.6, height: 2.04, yaw: 0 };

it("blocks until fully open and waits for the last walker on either side", () => {
  const blockers: boolean[] = [];
  const door = new HouseDoor(HAWK, (closed) => blockers.push(closed));
  const outside = { ...HAWK, z: HAWK.z + 1 };
  const inside = { ...HAWK, z: HAWK.z - 1 };

  door.tick(0.3, [outside, inside]);
  expect(blockers).toEqual([true]);
  door.tick(0.3, [outside, inside]);
  expect(blockers).toEqual([true, false]);
  for (let i = 0; i < 60; i++) door.tick(0.05, [inside]);
  expect(door.openness).toBe(1);
  for (let i = 0; i < 60; i++) door.tick(0.05, []);
  expect(door.openness).toBe(0);
  expect(blockers).toEqual([true, false, true]);
  door.requestOpen();
  door.tick(0.6, []);
  expect(door.openness).toBe(1);
});

it("measures nearness in the door's own frame for a turned house", () => {
  // Hazel House (yaw 270, front W): the street is -x of the door, the opening runs along z
  const hazel: DoorLeafSpec = { x: 143.76, y: 0.53, z: 150.375, width: 1.07, height: 2.44, yaw: 270 };
  expect(doorLocal(hazel, 143.76 - 1, 150.375)[1]).toBeCloseTo(1, 6);   // 1 m out on the street = local +z
  const door = new HouseDoor(hazel, () => {});
  expect(door.near({ x: 143.76 - 1.2, y: 0.2, z: 150.375 })).toBe(true);
  expect(door.near({ x: 143.76, y: 0.53, z: 150.375 + 1.5 })).toBe(false);   // beside the opening, along the facade
  expect(door.near({ x: 143.76 - 1.2, y: 1.2, z: 150.375 })).toBe(false);   // a floor up
});

it("puts the hinge on the named jamb and swings the leaf inward", () => {
  const right = doorHinge({ ...HAWK, hinge: "right" });
  expect([right.x, right.z, right.sign]).toEqual([HAWK.x + 0.8, HAWK.z, -1]);
  const turned = doorHinge({ ...HAWK, yaw: 180 });   // left jamb of a door facing -z sits at +x
  expect(turned.x).toBeCloseTo(HAWK.x + 0.8, 6);
});

it("the closed box stops a capsule crossing the threshold of a turned door", () => {
  const d: DoorLeafSpec = { x: 0, y: 0.5, z: 0, width: 1.1, height: 2.4, yaw: 90 };   // opening along z, street at +x
  const mesh = boxesMesh([doorBox(d)], [0, 0], "door:t")!;
  const world = createCapsuleWorld(() => [mesh]);
  expect(world.blocked([1, 0.5, 0], [-1, 0.5, 0], 0.4)).not.toBeNull();
  expect(world.blocked([1, 0.5, 2], [-1, 0.5, 2], 0.4)).toBeNull();
});

it("a sliding pair closes the whole opening, steps inward, then parts clear of it", () => {
  // Stone Cabin: a 2.4 m opening, two 1.56 m panes overlapping 0.72 m at the middle
  const cabin: DoorLeafSpec = { x: -17.2, y: 0.48, z: 86.35, width: 2.4, height: 2.775, yaw: 0, slide: true, leafWidth: 1.56 };
  const shut = slidePanels(cabin, 0);
  expect(shut[0]![0]).toBeCloseTo(0, 6);
  expect(shut[1]![0]).toBeCloseTo(0.84, 6);   // right pane's left edge: its right edge sits on the right jamb
  expect(shut[1]![1]).toBeLessThan(shut[0]![1] + 1e-9);   // rides behind the left one
  const open = slidePanels(cabin, 1);
  expect(open[0]![0] + 1.56).toBeCloseTo(0, 6);   // left pane wholly past the left jamb
  expect(open[1]![0]).toBeCloseTo(2.4, 6);   // right pane wholly past the right jamb
  expect(open.every(([, z]) => z <= -0.07 + 1e-9)).toBe(true);
  expect(slidePanels(cabin, 0.1).every(([x], i) => x === shut[i]![0])).toBe(true);   // inward step first, no slide yet
});
