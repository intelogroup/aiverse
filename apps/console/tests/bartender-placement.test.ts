// @vitest-environment node
// The bartender's spot against the SHIPPED Tea House furniture collision: he must stand clear of the counter and the shelves
// (the walker body is 0.4 m; his own collider is 0.22 m) and in front of the bottle shelves, behind the bar, inside the room.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BARTENDER_COLLIDER, BARTENDER_FLOOR_Y, BARTENDER_PLATFORM_H, BARTENDER_POS } from "../src/features/world/bartender";

const dir = new URL("../public/assets/interiors/", import.meta.url);
const col = JSON.parse(readFileSync(new URL("tea.col.json", dir), "utf8")) as { floorY: number; boxes: number[][] };
const tea = (JSON.parse(readFileSync(new URL("index.json", dir), "utf8")) as { id: string; rect: number[] }[]).find((r) => r.id === "tea")!;

/** Distance from a point to an axis-aligned (rot 0 / pi) or rotated box footprint. */
function dist(b: number[], x: number, z: number) {
  const [cx, cz, hx, hz, , , rot] = b;
  const dx = x - cx;
  const dz = z - cz;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.hypot(Math.max(Math.abs(lx) - hx, 0), Math.max(Math.abs(lz) - hz, 0));
}

describe("bartender placement in the shipped Tea House", () => {
  it("stands on the room floor, inside the room", () => {
    expect(BARTENDER_FLOOR_Y).toBe(col.floorY);
    const [x0, z0, x1, z1] = tea.rect;
    expect(BARTENDER_POS[0]).toBeGreaterThan(x0 + 1);
    expect(BARTENDER_POS[0]).toBeLessThan(x1 - 1);
    expect(BARTENDER_POS[1]).toBeGreaterThan(z0 + 0.6);
    expect(BARTENDER_POS[1]).toBeLessThan(z1 - 1);
  });

  it("his collider (body + duckboard) clears every furniture box by >= 5 cm, and the duckboard fits the bar corridor", () => {
    const [cx, cz, hx, hz] = BARTENDER_COLLIDER;
    const probes: [number, number][] = [];
    for (const fx of [-1, -0.5, 0, 0.5, 1]) for (const fz of [-1, -0.5, 0, 0.5, 1]) probes.push([cx + fx * hx, cz + fz * hz]);
    const d = Math.min(...col.boxes.flatMap((b) => probes.map(([x, z]) => dist(b, x, z))));
    expect(d).toBeGreaterThanOrEqual(0.05);
    expect(BARTENDER_PLATFORM_H).toBeLessThan(0.5); // a board, not a stage
  });

  it("is behind the counter: the counter lies between him and the stools", () => {
    const counters = col.boxes.filter((b) => b[2] > 1.0 && b[3] > 0.5 && b[3] < 0.6); // the 2 m counters
    expect(counters.length).toBe(6);
    const front = Math.min(...counters.map((b) => b[1] - b[3]));
    expect(BARTENDER_POS[1]).toBeLessThan(front); // the counter is between him and the room
  });
});
