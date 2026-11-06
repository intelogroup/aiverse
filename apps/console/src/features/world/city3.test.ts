import { describe, expect, it } from "vitest";
import {
  CITY3_HEROES,
  HIDE_WITHIN,
  INTERIOR_LOAD_WITHIN,
  SHOW_BEYOND,
  cutawayHidden,
  heroDistance,
} from "./city3";

describe("cutawayHidden", () => {
  it("hides inside the near threshold and shows past the far one", () => {
    expect(cutawayHidden(HIDE_WITHIN - 1, false)).toBe(true);
    expect(cutawayHidden(SHOW_BEYOND + 1, true)).toBe(false);
  });
  it("keeps its previous state inside the hysteresis band", () => {
    const mid = (HIDE_WITHIN + SHOW_BEYOND) / 2;
    expect(cutawayHidden(mid, true)).toBe(true);
    expect(cutawayHidden(mid, false)).toBe(false);
  });
  it("never flickers while the camera hovers around one distance", () => {
    let hidden = false;
    const flips: boolean[] = [];
    for (const d of [70, 47, 50, 52, 49, 55, 58, 61, 59, 57]) {
      const next = cutawayHidden(d, hidden);
      if (next !== hidden) flips.push(next);
      hidden = next;
    }
    expect(flips).toEqual([true, false]);
  });
});

describe("hero presets", () => {
  it("each preset camera opens the cutaway and sits outside the building", () => {
    for (const h of CITY3_HEROES) {
      const [x, y, z] = h.view.position;
      const d = heroDistance(h, { x, y, z });
      expect(d).toBeLessThan(HIDE_WITHIN);
      expect(Math.hypot(x - h.center[0], z - h.center[1])).toBeGreaterThan(8);
    }
  });
  it("loads a furnishings GLB before the cutaway can open", () => {
    expect(INTERIOR_LOAD_WITHIN).toBeGreaterThan(SHOW_BEYOND);
  });
  it("uses distinct cutaway prefixes", () => {
    const p = CITY3_HEROES.map((h) => h.prefix);
    expect(new Set(p).size).toBe(p.length);
  });
});
