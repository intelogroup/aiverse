// @vitest-environment node
// L-A acceptance tests against the SHIPPED navmesh artifact
// (public/assets/world-city3-navmesh.bin, baked from the production
// collision GLB by tools/city3/navmesh). If the world changes, rebake;
// these tests are the gate that proves the bake still describes it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CityNav, type NavPoint } from "../src/features/world/cityNav";

const asset = (rel: string) => readFileSync(fileURLToPath(new URL(`../public/assets/${rel}`, import.meta.url)));
const assetJson = <T,>(rel: string): T => JSON.parse(asset(rel).toString("utf8")) as T;

const ORIGIN: NavPoint = { x: 12, y: 0.2, z: 12 }; // plaza ring, by the fountain

let nav: CityNav;
beforeAll(async () => {
  nav = await CityNav.create(new Uint8Array(asset("world-city3-navmesh.bin")));
}, 60_000);

/** The census verdict rule (see tools/city3/navmesh/census_navmesh.mjs). */
function censusVerdict(target: NavPoint): { verdict: string; clampDist: number; endGap: number | null } {
  const c = nav.clamp(target);
  if (!c) return { verdict: "NO-CLAMP", clampDist: Infinity, endGap: null };
  const clampDist = Math.hypot(c.x - target.x, c.z - target.z);
  const r = nav.route(ORIGIN, target);
  if (!r) return { verdict: "NO-PATH", clampDist, endGap: null };
  return { verdict: clampDist > 2.0 ? "FAR-CLAMP" : r.endGap > 0.75 ? "PARTIAL" : "OK", clampDist, endGap: r.endGap };
}

describe("baked City 3 navmesh", () => {
  it("loads and answers on the plaza", () => {
    const p = nav.clamp(ORIGIN);
    expect(p).not.toBeNull();
    expect(Math.hypot(p!.x - ORIGIN.x, p!.z - ORIGIN.z)).toBeLessThan(1);
  });

  it("routes plaza -> Tea House interior through the door (a known corridor)", () => {
    const r = nav.route(ORIGIN, { x: -22.9167, y: 0.48, z: -75.5 });
    expect(r).not.toBeNull();
    expect(r!.endGap).toBeLessThan(0.75);
    const euclid = Math.hypot(-22.9167 - ORIGIN.x, -75.5 - ORIGIN.z);
    expect(r!.distance).toBeGreaterThan(euclid); // any real route detours; a straight line would mean it cut through walls
  });

  it("never routes through a building: the path around a market block stays out of its rect", () => {
    // Today's Tea block (shop-65): rect [-98.5, -57.5, -72.5, -45.5]. Cross it south -> north.
    const a: NavPoint = { x: -85.5, y: 0.4, z: -62 };
    const b: NavPoint = { x: -85.5, y: 0.4, z: -40 };
    const r = nav.route(a, b);
    expect(r).not.toBeNull();
    const rect = [-98.5, -57.5, -72.5, -45.5];
    const pts = [a, ...r!.waypoints];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1];
      const q = pts[i];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      for (let s = 0; s <= len; s += 0.2) {
        const x = p.x + ((q.x - p.x) * s) / (len || 1);
        const z = p.z + ((q.z - p.z) * s) / (len || 1);
        const inside = x > rect[0] + 0.3 && z > rect[1] + 0.3 && x < rect[2] - 0.3 && z < rect[3] - 0.3;
        expect(inside, `path segment enters the building rect at (${x.toFixed(1)}, ${z.toFixed(1)})`).toBe(false);
      }
    }
    expect(r!.distance).toBeGreaterThan(22 * 1.1); // forced around the block, not through it
  });

  it("census: every published place stand, room door and room centre is reachable from the plaza", () => {
    interface Place { id: string; stand: [number, number] }
    interface Room { id: string; door: [number, number]; center: [number, number] }
    const places = assetJson<Place[]>("city3-places.json");
    const rooms = assetJson<Room[]>("interiors/index.json");
    const defects: string[] = [];
    for (const p of places) {
      const v = censusVerdict({ x: p.stand[0], y: 0.7, z: p.stand[1] });
      // Known defect (NAVMESH census 2026-11-08): hall-0's stand sits in an
      // entrance pinch; the corridor ends 2.3 m short and the final leg is
      // greedy. Any OTHER place failing is a regression.
      if (p.id === "hall-0") {
        expect(v.endGap).not.toBeNull();
        expect(v.endGap!).toBeLessThan(2.5);
        continue;
      }
      if (v.verdict !== "OK") defects.push(`place ${p.id}: ${v.verdict} clamp=${v.clampDist.toFixed(2)} endGap=${v.endGap}`);
    }
    for (const room of rooms) {
      const vd = censusVerdict({ x: room.door[0], y: 0.7, z: room.door[1] });
      if (vd.verdict !== "OK") defects.push(`door ${room.id}: ${vd.verdict}`);
      const vc = censusVerdict({ x: room.center[0], y: 0.7, z: room.center[1] });
      if (vc.verdict !== "OK") defects.push(`centre ${room.id}: ${vc.verdict} (through the doorway)`);
    }
    expect(defects).toEqual([]);
  }, 120_000);

  it("census: the shipped Bazaar eggs, Mira's patio and the Tea House are reachable", () => {
    interface EggDoc { eggs: { id: string; district: string; position: [number, number, number] }[] }
    const eggs = assetJson<EggDoc>("collectibles/easter-eggs.json").eggs.filter((e) => e.district === "bazaar");
    expect(eggs.length).toBe(6);
    for (const e of eggs) {
      const v = censusVerdict({ x: e.position[0], y: 0.7, z: e.position[2] });
      // Known defect: egg-bazaar-03 sits on a navmesh island sealed by
      // erosion; the corridor ends 1.26 m short (inside the 1.5 m claim
      // radius, but no through-path). Pinned here so it can never silently
      // get worse — and so a future rebake that fixes it updates this test.
      if (e.id === "egg-bazaar-03") {
        expect(v.verdict).toBe("PARTIAL");
        expect(v.endGap!).toBeGreaterThan(0.75);
        expect(v.endGap!).toBeLessThan(1.5);
        continue;
      }
      expect(v.verdict, `${e.id}`).toBe("OK");
    }
    expect(censusVerdict({ x: -26.6, y: 0.2, z: -70.4 }).verdict).toBe("OK"); // Mira's patio
    expect(censusVerdict({ x: -22.9167, y: 0.2, z: -72.5 }).verdict).toBe("OK"); // Tea House door
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Separation layer (c) integration: a push inside the Tea House doorway,
// clamped by the navmesh, never leaves a body inside a wall.
import { separateBodies, type BodyDisc } from "../src/features/world/separation";

describe("separation + navmesh clamp in the Tea House doorway", () => {
  it("two bodies meeting in the 1 m doorway resolve without wall clips", () => {
    const disc = (id: string, x: number, z: number): BodyDisc => ({ id, x, y: 0.48, z, vx: 0, vz: 0 });
    const a = disc("a", -23.1, -72.3);
    const b = disc("b", -22.8, -72.7);
    const clamp = (d: BodyDisc) => {
      const s = nav.clamp({ x: d.x, y: d.y, z: d.z }, { x: 1.6, y: 2.5, z: 1.6 });
      if (s) {
        d.x = s.x;
        d.z = s.z;
        d.y = s.y;
      }
    };
    const first = separateBodies([a, b], {}, clamp);
    let res = first;
    for (let i = 0; i < 20; i++) res = separateBodies([a, b], {}, clamp);
    expect(nav.onMesh(a.x, a.y, a.z, 0.1)).toBe(true);
    expect(nav.onMesh(b.x, b.y, b.z, 0.1)).toBe(true);
    expect(first.maxPenetrationBefore).toBeGreaterThan(0.15);
    expect(res.maxPenetrationAfter).toBeLessThan(first.maxPenetrationBefore);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(0.5);
  });
});
