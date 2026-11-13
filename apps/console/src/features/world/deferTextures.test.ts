import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { deferTextures } from "./deferTextures";

// One triangle, a base-colour map and a normal map, both external KTX2 uris (as in the world tiles).
const gltf = {
  asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } }],
  textures: [{ source: 0 }, { source: 1 }], images: [{ uri: "a.ktx2", mimeType: "image/ktx2" }, { uri: "n.ktx2", mimeType: "image/ktx2" }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [0, 0, 0] }],
  bufferViews: [{ buffer: 0, byteLength: 36 }], buffers: [{ byteLength: 36, uri: "data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
};
const parse = (loader: GLTFLoader) => new Promise<THREE.Group>((res, rej) => loader.parse(JSON.stringify(gltf), "/assets/tiles/", (g) => res(g.scene), rej));
const material = (scene: THREE.Group) => { let m!: THREE.MeshStandardMaterial; scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial; }); return m; };

describe("deferTextures", () => {
  it("mounts at once on neutral placeholders, then swaps in the real textures with the slot's colour space", async () => {
    const real = { a: new THREE.Texture(), n: new THREE.Texture() };
    const urls: string[] = []; let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); // the "network"
    const ktx2 = { loadAsync: (u: string) => { urls.push(u); return gate.then(() => (u.endsWith("a.ktx2") ? real.a : real.n)); } } as unknown as KTX2Loader;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder); deferTextures(loader, ktx2); deferTextures(loader, ktx2); // second call is a no-op
    const scene = await parse(loader);
    const mat = material(scene);
    // placeholders: base colour mid-grey, normal map the flat normal; nothing fetched before parse returned its scene
    expect((mat.map!.image as { data: Uint8Array }).data).toEqual(new Uint8Array([190, 182, 170, 255]));
    expect((mat.normalMap!.image as { data: Uint8Array }).data).toEqual(new Uint8Array([128, 128, 255, 255]));
    release();
    await vi.waitFor(() => { expect(mat.map).toBe(real.a); expect(mat.normalMap).toBe(real.n); });
    expect(urls.sort()).toEqual([expect.stringMatching(/\/assets\/tiles\/a\.ktx2$/), expect.stringMatching(/\/assets\/tiles\/n\.ktx2$/)]);
    expect(real.a.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(real.a.flipY).toBe(false);
  });
  it("leaves embedded images to the stock loader", () => {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder); deferTextures(loader, {} as KTX2Loader);
    const cb = (loader as unknown as { pluginCallbacks: ((p: unknown) => { loadTexture(i: number): unknown })[] }).pluginCallbacks[0];
    const plugin = cb({ json: { textures: [{ source: 0 }], images: [{ bufferView: 1, mimeType: "image/png" }] }, options: { path: "/", manager: new THREE.LoadingManager() } });
    expect(plugin.loadTexture(0)).toBeNull();
  });
});
