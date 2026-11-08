import { describe, expect, it, vi } from "vitest";
import {
  SPAWN_DOOR_OFFSET,
  mobileShell,
  spawnRequestForPoint,
  spawnRequestForRoom,
} from "./mobileShell";
import { frontVector, type City3Room } from "./city3";

function room(front: City3Room["front"], door: [number, number]): City3Room {
  return {
    id: "r",
    lot: "shop-1",
    name: "Tea House",
    template: "t",
    front,
    center: [door[0], door[1] + 5],
    door,
    rect: [door[0] - 5, door[1], door[0] + 5, door[1] + 10],
    cut: { rect: [door[0] - 5, door[1], door[0] + 5, door[1] + 10], y: 3 },
    layout: "l.json",
    featured: true,
  };
}

describe("frontVector", () => {
  it("points out of each front (three.js: S = +Z, N = -Z)", () => {
    expect(frontVector("S")).toEqual([0, 1]);
    expect(frontVector("N")).toEqual([0, -1]);
    expect(frontVector("E")).toEqual([1, 0]);
    expect(frontVector("W")).toEqual([-1, 0]);
  });
});

describe("spawnRequestForRoom", () => {
  it("centres the probe just outside the door, on the street side, facing the door", () => {
    const s = spawnRequestForRoom(room("S", [-22.9167, -72.5]));
    expect(s.x).toBeCloseTo(-22.9167);
    expect(s.z).toBeCloseTo(-72.5 + SPAWN_DOOR_OFFSET); // S front faces +Z
    expect(s.faceX).toBeCloseTo(-22.9167);
    expect(s.faceZ).toBeCloseTo(-72.5);
  });
  it("respects the other fronts", () => {
    expect(spawnRequestForRoom(room("N", [10, 20])).z).toBeCloseTo(20 - SPAWN_DOOR_OFFSET);
    expect(spawnRequestForRoom(room("E", [10, 20])).x).toBeCloseTo(10 + SPAWN_DOOR_OFFSET);
    expect(spawnRequestForRoom(room("W", [10, 20])).x).toBeCloseTo(10 - SPAWN_DOOR_OFFSET);
  });
});

describe("spawnRequestForPoint", () => {
  it("probes and faces the point itself (a tapped figure)", () => {
    expect(spawnRequestForPoint(3, -7)).toEqual({ x: 3, z: -7, faceX: 3, faceZ: -7 });
  });
});

describe("mobileShell bridge", () => {
  it("notifies subscribers on places / walk-live changes and dedupes no-ops", () => {
    const fn = vi.fn();
    const off = mobileShell.subscribe(fn);
    const src = { rooms: [], flyTo: () => {}, walkTo: () => {} };
    mobileShell.setPlaces(src);
    expect(mobileShell.getSnapshot().places).toBe(src);
    expect(fn).toHaveBeenCalledTimes(1);
    mobileShell.setPlaces(src); // same reference: no notification
    expect(fn).toHaveBeenCalledTimes(1);
    mobileShell.setWalkLive(true);
    expect(mobileShell.getSnapshot().walkLive).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
    mobileShell.setPlaces(null);
    mobileShell.setWalkLive(false);
    expect(mobileShell.getSnapshot()).toEqual({ places: null, walkLive: false });
    off();
  });
});
