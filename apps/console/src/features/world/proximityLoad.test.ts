import { describe, expect, it } from "vitest";
import { RESIDENT_LOAD_RADIUS, withinLoadRadius } from "./proximityLoad";

describe("withinLoadRadius", () => {
  it("is false from the default wide aerial pose (about 450 m out)", () => {
    expect(withinLoadRadius(290, 250, 340, 0, 0, 0)).toBe(false);
  });
  it("is true at the edge and false just past it (3D, not horizontal)", () => {
    expect(withinLoadRadius(RESIDENT_LOAD_RADIUS, 0, 0, 0, 0, 0)).toBe(true);
    expect(withinLoadRadius(RESIDENT_LOAD_RADIUS + 0.01, 0, 0, 0, 0, 0)).toBe(false);
    // directly overhead at 250 m: close horizontally, far in 3D
    expect(withinLoadRadius(0, 250, 0, 0, 0, 0)).toBe(false);
  });
  it("is true for a walking camera a few metres away", () => {
    expect(withinLoadRadius(5, 3, 8, 0, 0, 0)).toBe(true);
  });
});
