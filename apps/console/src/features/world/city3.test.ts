import { describe, expect, it } from "vitest";
import { HIDE_WITHIN, SHOW_BEYOND, cutawayHidden } from "./city3";

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
