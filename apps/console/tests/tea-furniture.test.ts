// The Tea House furniture is patched into the shipped GLBs by tools/city3/bridge_tea_props.py. This pins the pairing the
// walker and the cutaway rely on: every visual piece has a blocker box that can never become floor.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function gltfJson(file: string) {
  const b = readFileSync(new URL("../public/assets/" + file, import.meta.url));
  return JSON.parse(b.toString("utf8", 20, 20 + b.readUInt32LE(12))) as { nodes: { name?: string; mesh?: number; extras?: Record<string, unknown> }[]; materials: { name?: string }[]; meshes: { primitives: { indices?: number }[] }[]; accessors: { componentType: number }[] };
}

describe("Tea House furniture", () => {
  const visual = gltfJson("world-city3.glb"), collision = gltfJson("world-city3-collision.glb");
  const pieces = visual.nodes.filter((n) => /^(G|L[123])_prop_\d+_/.test(n.name ?? ""));
  const boxes = collision.nodes.filter((n) => (n.name ?? "").startsWith("col_tea_prop_"));
  it("has furniture on every level, one blocker per piece", () => {
    expect(pieces.length).toBeGreaterThan(40);
    expect(boxes.length).toBe(pieces.length);
    for (const level of ["G", "L1", "L2", "L3"]) expect(pieces.some((n) => n.name!.startsWith(level + "_prop_")), level).toBe(true);
  });
  it("blockers never become floors", () => {
    for (const b of boxes) expect(b.extras?.noGround, b.name).toBe(true);
  });
  it("shares one mesh per prop type (geometry is stored once)", () => {
    const meshes = new Set(pieces.map((n) => n.mesh));
    expect(meshes.size).toBeLessThan(pieces.length / 2);
  });
  it("uses unsigned-int indices on prop meshes", () => {
    for (const m of new Set(pieces.map((n) => n.mesh))) for (const p of visual.meshes[m!].primitives) expect(visual.accessors[p.indices!].componentType).toBe(5125);
  });
  it("textured every prop material", () => {
    expect(visual.materials.filter((m) => m.name?.startsWith("TeaProp_")).length).toBeGreaterThanOrEqual(14);
  });
});
