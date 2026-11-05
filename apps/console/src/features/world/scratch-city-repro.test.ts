// @vitest-environment node
// SCRATCH repro (not part of the suite): replicate the aa87551 City crowd
// construction exactly as GlbWorld did — buildRectGeometry over the
// street rect + createGeometryCrowd with the home-grid initialPositions —
// step it, and print where the frames actually land.
import { describe, expect, it } from "vitest";
import { buildRectGeometry, createGeometryCrowd } from "./locomotion";

const CITY_CENTER: [number, number] = [-165, -95];
const CITY_RECT_W = 110;
const CITY_RECT_D = 70;
const CITY_GROUND_Y = 0.22;

function cityHome(i: number, n: number): [number, number] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const col = i % cols;
  const row = Math.floor(i / cols);
  const x = CITY_CENTER[0] - CITY_RECT_W / 2 + 10 + col * ((CITY_RECT_W - 20) / Math.max(1, cols - 1 || 1));
  const z = CITY_CENTER[1] - CITY_RECT_D / 2 + 10 + row * 20;
  return [x, z];
}

describe("scratch: aa87551 city crowd", () => {
  it("frames land inside the street rect", async () => {
    const count = 6;
    const initialPositions = Array.from({ length: count }, (_, i) => cityHome(i, count));
    const geo = buildRectGeometry(CITY_CENTER[0], CITY_CENTER[1], CITY_GROUND_Y, CITY_RECT_W, CITY_RECT_D);
    const crowd = await createGeometryCrowd(geo.positions, geo.indices, count, {
      cellSize: 0.5,
      initialPositions,
    });
    let frames = crowd.step(0.016);
    console.log("t=0 frames:", JSON.stringify(frames.map((f) => f.position)));
    for (let s = 0; s < 30; s++) frames = crowd.step(0.1);
    console.log("t=3s frames:", JSON.stringify(frames.map((f) => f.position)));
    for (const f of frames) {
      expect(Number.isFinite(f.position[0])).toBe(true);
      expect(Number.isFinite(f.position[1])).toBe(true);
      expect(Math.abs(f.position[0] - CITY_CENTER[0])).toBeLessThanOrEqual(CITY_RECT_W / 2 + 1);
      expect(Math.abs(f.position[1] - CITY_CENTER[1])).toBeLessThanOrEqual(CITY_RECT_D / 2 + 1);
    }
    crowd.dispose();
  }, 60000);
});
