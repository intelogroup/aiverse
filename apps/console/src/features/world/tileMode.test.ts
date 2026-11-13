import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { originOf, planDistricts, type DistrictDef } from "./districts";
import { tileScenes } from "./tileScenes";
import { makeWalkWorld } from "./walkerBody";
import { WalkColliders } from "./walkColliders";

// A row of 18 m world tiles along +x, the first one the resident core on the fountain.
const tile = (i: number): DistrictDef => ({ id: `t${i}`, name: `t${i}`, url: `t${i}.glb`, center: [i * 18, 0], half: 9, theme: "a", origin: [0, 0], ...(i === 0 ? { resident: true } : {}) });
const tiles = Array.from({ length: 12 }, (_, i) => tile(i));

describe("world tiles: districts plumbing", () => {
  it("originOf is the centre for districts and [0,0] for tiles that are already in world coordinates", () => {
    expect(originOf({ id: "d", name: "d", url: "", center: [400, 0], half: 180, theme: "a" })).toEqual([400, 0]);
    expect(originOf(tiles[3])).toEqual([0, 0]);
  });
  it("streams the tiles within the manifest's load radius, nearest first, never the resident, within the cap", () => {
    const plan = planDistricts([0, 0], tiles, new Set(["t0"]), { loadR: 40, cap: 4 });
    expect(plan.load).toEqual(["t1", "t2"]); // edges at 9 m and 27 m are inside 40 m; t3's edge is at 45 m
    expect(planDistricts([0, 0], tiles, new Set(["t0"]), { loadR: 40, cap: 1 }).load).toEqual(["t1"]); // the cap counts streamed tiles, not the resident
    expect(planDistricts([0, 0], tiles, new Set(), { loadR: 40 }).load).not.toContain("t0");
    const far = planDistricts([0, 0], tiles, new Set(["t1", "t9"]), { loadR: 40, keepR: 110 });
    expect(far.unload).toEqual(["t9"]); // beyond the keep radius; the resident is never listed
  });
});

describe("tileScenes", () => {
  it("tracks mounted tiles and ticks the epoch on every change", () => {
    const seen = vi.fn(); const off = tileScenes.subscribe(seen); const e0 = tileScenes.epoch();
    const root = new THREE.Group();
    tileScenes.set("tea", root);
    expect(tileScenes.get("tea")).toBe(root);
    tileScenes.drop("tea");
    tileScenes.drop("tea"); // already gone: no tick
    expect(tileScenes.get("tea")).toBeUndefined();
    expect(tileScenes.epoch()).toBe(e0 + 2);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });
});

describe("walk world: collision coverage gate", () => {
  const ground = () => { const m = new THREE.Mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial()); m.updateMatrixWorld(true); return m; };
  it("reports no ground where the tile's collision has not streamed in, and delegates elsewhere", () => {
    const walk = new WalkColliders(); walk.status = "failed"; // the raycast world over the visual meshes: enough to prove the seam
    const world = makeWalkWorld(() => [ground()], walk);
    expect(world.groundY(5, 5, 2)).toBeCloseTo(0, 5); // no gate set: untouched
    walk.covered = (x) => x < 10;
    expect(world.groundY(5, 5, 2)).toBeCloseTo(0, 5);
    expect(world.groundY(20, 5, 2)).toBeNull(); // uncovered: the walker meets a ledge and stops
  });
});

describe("tilesEnabled", () => {
  it("follows the build default, and ?tiles=0 / ?tiles=1 override it", async () => {
    const { tilesEnabled } = await import("./tilesMode");
    expect(tilesEnabled("", true)).toBe(true);
    expect(tilesEnabled("", false)).toBe(false);
    expect(tilesEnabled("?walk=1", true)).toBe(true);
    expect(tilesEnabled("?tiles=0", true)).toBe(false);
    expect(tilesEnabled("?tiles=1", false)).toBe(true);
    expect(tilesEnabled("?tiles", false)).toBe(true); // the old bare flag still means on
  });
});
