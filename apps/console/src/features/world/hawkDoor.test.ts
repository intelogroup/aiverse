import { expect, it } from "vitest";
import { HAWK_DOOR, HawkDoor } from "./hawkDoor";

it("blocks until fully open and waits for the last walker on either side", () => {
  const blockers: boolean[] = [];
  const door = new HawkDoor((closed) => blockers.push(closed));
  const outside = { ...HAWK_DOOR, z: HAWK_DOOR.z + 1 };
  const inside = { ...HAWK_DOOR, z: HAWK_DOOR.z - 1 };

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
