// @vitest-environment node
// The Tea House door's painted leaf as shipped: tools/city3 bakes it into the shared palette mesh (failures-log row 36), so the
// door pilot must carve it out to swing with the glass. This loads the REAL world-city3.glb (textures stripped; meshopt decoded)
// and checks the carve finds the leaf there, and that apply/restore round-trips the shared index exactly.
// Lives outside src/ like glb-inventory.test.ts (the app tsconfig is browser-typed).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { findBakedLeaf } from "../src/features/world/bakedLeaf";
import { TEA_DOOR_ORIGIN } from "../src/features/world/teaDoor";

/** Drop images/textures (no DOM in node) but keep geometry and the meshopt extension. */
function stripTextures(buf: Buffer): ArrayBuffer {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const dv = new DataView(ab);
  const jl = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 20, jl)));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const k of ["extensionsUsed", "extensionsRequired"]) {
    if (json[k]) json[k] = json[k].filter((e: string) => !/texture|basisu|webp/i.test(e));
  }
  const kill = (o: unknown) => {
    if (o && typeof o === "object") for (const k of Object.keys(o)) { if (/Texture$/.test(k)) delete (o as Record<string, unknown>)[k]; else kill((o as Record<string, unknown>)[k]); }
  };
  kill(json.materials);
  const js = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (js.length % 4)) % 4;
  const j2 = new Uint8Array(js.length + pad).fill(32);
  j2.set(js);
  const rest = new Uint8Array(ab, 20 + jl);
  const out = new Uint8Array(20 + j2.length + rest.length);
  const o = new DataView(out.buffer);
  o.setUint32(0, 0x46546c67, true);
  o.setUint32(4, 2, true);
  o.setUint32(8, out.length, true);
  o.setUint32(12, j2.length, true);
  o.setUint32(16, 0x4e4f534a, true);
  out.set(j2, 20);
  out.set(rest, 20 + j2.length);
  return out.buffer;
}

describe("the Tea House door's baked leaf in the shipped world", () => {
  it("is found in the palette mesh (86 triangles on this build), split over both leaves, and apply/restore round-trips the index", async () => {
    const buf = readFileSync(new URL("../public/assets/world-city3.glb", import.meta.url));
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => loader.parse(stripTextures(buf), "", res, rej));
    let found: ReturnType<typeof findBakedLeaf> = null;
    let src: THREE.BufferGeometry | null = null;
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (found || !m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return;
      const f = findBakedLeaf(m.geometry, TEA_DOOR_ORIGIN);
      if (f) { found = f; src = m.geometry; }
    });
    expect(found, "the leaf must be found in some non-instanced mesh").not.toBeNull();
    const leaf = found!;
    // Measured 2026-11-07 (style 2 'double'): a change here means the generator or the volume moved: re-measure, do not just edit.
    expect(leaf.count).toBe(86);
    expect(leaf.left.getAttribute("position").count / 3).toBeGreaterThan(30);
    expect(leaf.right.getAttribute("position").count / 3).toBeGreaterThan(30);
    leaf.left.computeBoundingBox();
    leaf.right.computeBoundingBox();
    expect(leaf.left.boundingBox!.min.x).toBeCloseTo(TEA_DOOR_ORIGIN.x - 0.72, 1);
    expect(leaf.right.boundingBox!.max.x).toBeCloseTo(TEA_DOOR_ORIGIN.x + 0.72, 1);
    expect(leaf.left.boundingBox!.max.y).toBeCloseTo(2.6, 1);

    const idx = src!.getIndex()!;
    const before = Array.from(idx.array);
    leaf.apply();
    expect(Array.from(idx.array)).not.toEqual(before);
    leaf.restore();
    expect(Array.from(idx.array)).toEqual(before);

    // A second carve on the restored world finds the same thing (what StrictMode's second mount does).
    const again = findBakedLeaf(src!, TEA_DOOR_ORIGIN);
    expect(again?.count).toBe(86);
  }, 120_000);
});
