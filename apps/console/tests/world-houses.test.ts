// @vitest-environment node
// Placed prebuilt houses (tools/city3/houses.sh): the server sim holds each house's collision where the console draws it (district origin),
// so server bodies and the navmesh meet the same walls the viewer sees.
import { existsSync, readFileSync } from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";

const ASSETS = new URL("../public/assets/", import.meta.url).pathname;
const houses = (JSON.parse(readFileSync(ASSETS + "districts.json", "utf8")).districts as { id: string; center: [number, number]; origin?: [number, number]; farUrl?: string }[])
  .filter((d) => d.id.startsWith("house-"));
let sim: Awaited<ReturnType<typeof loadVerseSim>>["sim"];
beforeAll(async () => {
  ({ sim } = await loadVerseSim(ASSETS));
}, 120_000);

describe("placed houses", () => {
  it("there are houses to check", () => expect(houses.length).toBeGreaterThan(0));
  it("every house has a far stand-in on disk (house_lods.mjs), so the aerial sees it before its detail streams", () => {
    const missing = houses.filter((d) => !d.farUrl || !existsSync(ASSETS + d.farUrl.replace(/^\/assets\//, "")));
    expect(missing.map((d) => d.id)).toEqual([]);
  });
  it("far stand-ins have finite bounds and no empty geometry streams", () => {
    const urls = new Set(houses.flatMap(d => d.farUrl ? [d.farUrl] : []));
    for (const url of urls) {
      const glb = readFileSync(ASSETS + url.replace(/^\/assets\//, ""));
      const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as {
        accessors: { count: number; min?: number[]; max?: number[] }[];
      };
      const invalid = json.accessors.filter(accessor =>
        accessor.count <= 0 || [...(accessor.min ?? []), ...(accessor.max ?? [])].some(n => !Number.isFinite(n)),
      );
      expect(invalid, url).toEqual([]);
    }
  });
  for (const d of houses) {
    it(`${d.id}: collision sits on its lot (around the district origin)`, () => {
      const meshes = sim.walk.get(d.id) ?? [];
      expect(meshes.length, `no collision set ${d.id}`).toBeGreaterThan(0);
      const box = new THREE.Box3();
      for (const m of meshes) { m.updateMatrixWorld(true); box.expandByObject(m); }
      const [ox, oz] = d.origin ?? d.center;
      const c = box.getCenter(new THREE.Vector3());
      expect(Math.hypot(c.x - ox, c.z - oz), `${d.id} collision centre ${c.x.toFixed(1)},${c.z.toFixed(1)} vs origin ${ox},${oz}`).toBeLessThan(15);
    });
  }
});
