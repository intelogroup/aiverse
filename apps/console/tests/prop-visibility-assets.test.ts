// @vitest-environment node
// The plaza's open bench/stall meshes must survive a view from either side.
// Guard the shipped artifact, not just build_city.py: source material fixes can
// otherwise be lost when an older GLB is copied back into public/assets.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type CityAsset = {
  nodes: { name?: string; mesh?: number }[];
  meshes: { name?: string; primitives: { material?: number }[] }[];
  materials: { name?: string; doubleSided?: boolean }[];
};
const bytes = readFileSync(new URL("../public/assets/world-city3.glb", import.meta.url));
const city: CityAsset = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));

describe("shipped plaza prop visibility", () => {
  for (const kind of ["SK_med_bench", "SK_med_stall"]) {
    it(`${kind}: every placed primitive renders its back faces`, () => {
      const nodes = city.nodes.filter((node) => node.name === kind || node.name?.startsWith(`${kind}.`));
      expect(nodes.length).toBeGreaterThan(0);
      const meshes = new Set(nodes.map((node) => node.mesh));
      for (const meshIndex of meshes) {
        expect(meshIndex).toBeDefined();
        const mesh = city.meshes[meshIndex!];
        expect(mesh.primitives.length).toBeGreaterThan(0);
        for (const primitive of mesh.primitives) {
          expect(primitive.material).toBeDefined();
          const material = city.materials[primitive.material!];
          expect(material.doubleSided, `${kind}: ${mesh.name} / ${material.name}`).toBe(true);
        }
      }
    });
  }
});
