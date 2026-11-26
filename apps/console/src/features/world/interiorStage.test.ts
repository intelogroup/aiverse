import { describe, expect, it } from "vitest";
import { interiorLook, interiorSunDir, insideRoom, type InteriorLook } from "./interiorStage";
import type { City3Room } from "./city3";

const room = (over: Partial<City3Room> = {}): City3Room => ({
  id: "loft",
  lot: "loft",
  name: "The Loft",
  template: "house",
  front: "S",
  center: [-24.2, -114.6],
  door: [-24.2, -111.3],
  rect: [-27.76, -118, -20.69, -111.26],
  cut: { rect: [-27.86, -118.1, -20.59, -111.16], y: 4.42 },
  layout: "/assets/interiors/house-zen-pavilion-1.json",
  featured: true,
  ...over,
});

describe("insideRoom", () => {
  it("finds the room for a camera standing inside, margin shrunk", () => {
    expect(insideRoom([room()], -24.2, -114.6)?.id).toBe("loft");
    expect(insideRoom([room()], -24.2, -111.3)).toBe(null); // within the doorway lip
    expect(insideRoom([room()], -24.2, -109)).toBe(null); // the outdoor street control
  });
  it("engages at the loft entry spawn (the margin-1.0 miss, measured 2026-11-25)", () => {
    expect(insideRoom([room()], -24.2, -112.3)?.id).toBe("loft"); // 1.04 m inside the front edge
    expect(insideRoom([room()], -24.2, -108.7)).toBe(null); // harness street control, 2.5 m out
  });
  it("prefers nothing when rects do not contain the point", () => {
    expect(insideRoom([], 0, 0)).toBe(null);
    expect(insideRoom([room()], 100, 100)).toBe(null);
  });
});

describe("interiorSunDir", () => {
  it("points from the street side at the authoring elevation", () => {
    const [x, y, z] = interiorSunDir(room());
    expect(y).toBeCloseTo(Math.sin((22 * Math.PI) / 180), 5); // elevation 22 deg
    expect(z).toBeGreaterThan(0.5); // through the S glazing, not overhead
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 8); // a unit vector
  });
});

describe("interiorLook", () => {
  it("fits the shadow box to the room and centres it at eye height", () => {
    const look: InteriorLook = interiorLook(room());
    expect(look.exposure).toBeGreaterThan(1.1); // above the noon-outdoor base
    expect(look.envIntensity).toBeGreaterThan(0.6);
    expect(look.shadowHalf).toBeLessThanOrEqual(14);
    expect(look.shadowHalf).toBeGreaterThan(3);
    expect(look.shadowCenter[0]).toBeCloseTo(-24.225, 2);
    expect(look.shadowCenter[2]).toBeCloseTo(-114.63, 2);
    expect(look.shadowCenter[1]).toBe(1.2);
  });
});
