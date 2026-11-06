import { describe, expect, it } from "vitest";
import {
  HIDE_WITHIN,
  INTERIOR_KEEP_WITHIN,
  INTERIOR_LOAD_WITHIN,
  SHOW_BEYOND,
  roomDistance,
  roomView,
  syntheticRooms,
  type City3Room,
  type Side,
} from "./city3";

const room = (front: Side): City3Room => ({
  id: "r",
  lot: "shop-1",
  name: "R",
  template: "cafe",
  front,
  center: [-25, -78.5],
  door: [-27, -72.5],
  rect: [-37.5, -84.5, -12.5, -72.5],
  cut: { rect: [-37.5, -85.2, -12.5, -71.8], y: 4.45 },
  layout: "/assets/interiors/r.json",
  featured: false,
});

describe("radii", () => {
  it("starts streaming before the cutaway can open, and keeps a room longer than it loads it", () => {
    expect(INTERIOR_LOAD_WITHIN).toBeGreaterThan(SHOW_BEYOND);
    expect(INTERIOR_KEEP_WITHIN).toBeGreaterThan(INTERIOR_LOAD_WITHIN);
    expect(SHOW_BEYOND).toBeGreaterThan(HIDE_WITHIN);
  });
});

describe("roomView", () => {
  it("puts the camera on the street side, inside the cutaway radius, looking at the room", () => {
    for (const side of ["S", "N", "E", "W"] as Side[]) {
      const r = room(side);
      const v = roomView(r);
      const d = roomDistance(r, { x: v.position[0], y: v.position[1], z: v.position[2] });
      expect(d).toBeLessThan(HIDE_WITHIN);
      expect(v.target[0]).toBe(r.center[0]);
      expect(v.target[2]).toBe(r.center[1]);
    }
    // S faces +Z (three.js), N faces -Z, E faces +X, W faces -X
    expect(roomView(room("S")).position[2]).toBeGreaterThan(-78.5);
    expect(roomView(room("N")).position[2]).toBeLessThan(-78.5);
    expect(roomView(room("E")).position[0]).toBeGreaterThan(-25);
    expect(roomView(room("W")).position[0]).toBeLessThan(-25);
  });
});

describe("syntheticRooms", () => {
  it("gives unique ids and shifts the source layout onto each new centre", () => {
    const fake = syntheticRooms(12, room("S"));
    expect(new Set(fake.map((f) => f.id)).size).toBe(12);
    for (const f of fake) {
      expect(f.layout).toBe("/assets/interiors/r.json");
      expect(f.center[0] - room("S").center[0]).toBeCloseTo(f.shift![0]);
      expect(f.center[1] - room("S").center[1]).toBeCloseTo(f.shift![1]);
    }
  });
});
