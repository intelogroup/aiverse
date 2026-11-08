// @vitest-environment node
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { splitTeaPanels } from "../src/features/world/teaDoorPanels";

it("moves the shipped green leaf triangles out of the static world, retaining all other triangles", async () => {
  const bytes = readFileSync(new URL("../public/assets/world-city3.glb", import.meta.url));
  const n = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + n).toString());
  const bin = bytes.subarray(28 + n);
  await MeshoptDecoder.ready;
  const views = new Map<number, Uint8Array>();
  function accessor(i: number) {
    const a = json.accessors[i], v = json.bufferViews[a.bufferView];
    let data = views.get(a.bufferView);
    if (!data) {
      const e = v.extensions?.EXT_meshopt_compression;
      if (e) {
        data = new Uint8Array(e.count * e.byteStride);
        MeshoptDecoder.decodeGltfBuffer(data, e.count, e.byteStride, bin.subarray(e.byteOffset, e.byteOffset + e.byteLength), e.mode, e.filter);
      } else data = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
      views.set(a.bufferView, data);
    }
    const size = a.type === "VEC3" ? 3 : a.type === "VEC2" ? 2 : 1;
    const component = a.componentType === 5126 || a.componentType === 5125 ? 4 : 2;
    const out = new Float32Array(a.count * size), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const stride = v.byteStride ?? v.extensions?.EXT_meshopt_compression?.byteStride ?? size * component;
    for (let k = 0; k < a.count; k++) for (let c = 0; c < size; c++) {
      const offset = (a.byteOffset ?? 0) + k * stride + c * component;
      out[k * size + c] = a.componentType === 5126 ? view.getFloat32(offset, true) : a.componentType === 5125 ? view.getUint32(offset, true) : view.getUint16(offset, true);
    }
    return new THREE.BufferAttribute(out, size);
  }
  const node = json.nodes.find((n: {name: string}) => n.name === "Props");
  expect(node).toBeDefined();
  const primitive = json.meshes[node.mesh].primitives[0];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", accessor(primitive.attributes.POSITION));
  geometry.setAttribute("normal", accessor(primitive.attributes.NORMAL));
  geometry.setAttribute("uv", accessor(primitive.attributes.TEXCOORD_0));
  geometry.setIndex(Array.from(accessor(primitive.indices).array));
  const split = splitTeaPanels(geometry, new THREE.Matrix4());
  expect(split).not.toBeNull();
  expect(split!.triangles).toBeGreaterThan(50);
  expect(split!.remaining.index!.count + split!.left.attributes.position.count + split!.right.attributes.position.count).toBe(geometry.index!.count);
  expect(splitTeaPanels(split!.remaining, new THREE.Matrix4())).toBeNull();
  expect(split!.left.boundingBox!.min.x).toBeCloseTo(-0.72, 2);
  expect(split!.right.boundingBox!.max.x).toBeCloseTo(0.72, 2);
  console.log("Painted tea door triangles moved:", split!.triangles);
});
