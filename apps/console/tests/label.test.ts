// @vitest-environment node
// Source-level checks for the CastFigure nameplate (Update B): no
// renderer in the test env, so these assert the shipped source carries
// the leader-line callout contract — world-proportional scaling via
// drei's distanceFactor, the SVG leader (dot + oblique + horizontal),
// the figure accent, and the Ride-hidden unmount. Visual verdict is
// Jim's on the preview. Lives outside src/ like glb-inventory.test.ts
// (browser-typed tsconfig in there).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../src/features/world/CastFigure.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/features/world/world.css", import.meta.url), "utf8");

describe("CastFigure nameplate — leader-line callout", () => {
  it("the label Html scales with distance (distanceFactor prop present)", () => {
    expect(src).toContain("distanceFactor={NAMEPLATE_DISTANCE_FACTOR}");
    expect(src).toContain("export const NAMEPLATE_DISTANCE_FACTOR = 10");
  });

  it("draws the leader: dot at the anchor, oblique line, horizontal run", () => {
    expect(src).toContain("<polyline");
    expect(src).toContain('points="230,75 268,30 448,30"');
    expect(src).toContain("<circle cx={230} cy={75}");
    // The name keeps its existing class, sitting on the horizontal run.
    expect(src).toContain('className="w-cast-name"');
    expect(css).toContain(".w-cast-tag .w-cast-name");
    expect(css).toContain("font-size: 30px");
  });

  it("the leader is drawn in the figure's own accent color", () => {
    expect(src).toContain("accentForFigure(label, index)");
    expect(src).toContain("stroke={tagAccent}");
  });

  it("stays unmounted while the figure is hidden (Ride)", () => {
    expect(src).toContain("label && !hidden");
  });
});
