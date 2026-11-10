// @vitest-environment node
// AIVERSE-2 regression guard: the shipped world GLBs REQUIRE EXT_meshopt_compression, so any
// GLTFLoader that loads one without setMeshoptDecoder() throws at parse time
// ("THREE.GLTFLoader: setMeshoptDecoder must be called before loading compressed files").
// Two layers: (1) a source invariant — every `new GLTFLoader(` in the console src and in
// packages/world-sim must be paired with setMeshoptDecoder in the same file (this is the
// check that would have caught the node sim loader, which loaded GLBs bare); (2) behaviour —
// the meshopt-required assets really do refuse a bare loader and really do load through the
// decoder-configured one (same configuration as DistrictWorld's streaming loader).
import { expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

globalThis.ProgressEvent ??= class {} as typeof ProgressEvent;
// three's meshopt glue expects a worker-ish global in node.
(globalThis as Record<string, unknown>).self ??= globalThis;

const consoleRoot = join(new URL(".", import.meta.url).pathname, "..");
const repoRoot = join(consoleRoot, "..", "..");

function listSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules") listSources(p, out); }
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

it("every GLTFLoader construction in console src and world-sim sets the meshopt decoder", () => {
  const offenders: string[] = [];
  for (const root of [join(consoleRoot, "src"), join(repoRoot, "packages", "world-sim")]) {
    for (const f of listSources(root)) {
      const src = readFileSync(f, "utf8");
      if (src.includes("new GLTFLoader(") && !src.includes("setMeshoptDecoder")) offenders.push(f.slice(repoRoot.length + 1));
    }
  }
  expect(offenders).toEqual([]);
});

// Same discipline for KTX2: world-city3.glb's textures are KHR_texture_basisu, which throw
// without a primed KTX2Loader — every drei useGLTF call in src must route through the
// shared extender (features/world/gltfExtensions.ts).
it("every useGLTF call in console src routes through the shared KTX2 extender", () => {
  const offenders: string[] = [];
  for (const f of listSources(join(consoleRoot, "src"))) {
    if (/\.test\.tsx?$/.test(f)) continue;
    const code = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    if (/[^.\w]useGLTF\(/.test(code) && !code.includes("extendGltf(")) offenders.push(f.slice(repoRoot.length + 1));
  }
  expect(offenders).toEqual([]);
});

async function parse(file: string, withDecoder: boolean) {
  const b = readFileSync(new URL(`../public/assets/${file}`, import.meta.url));
  const loader = new GLTFLoader();
  if (withDecoder) {
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.register(() => ({ name: "testMaterials", loadMaterial: () => Promise.resolve(new T.MeshBasicMaterial()) }));
  }
  return loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, "");
}

const REQUIRED = ["world-city3.glb", "world-city3-library.glb"];

it.each(REQUIRED)("%s refuses to load without a meshopt decoder (the AIVERSE-2 error)", async (file) => {
  await expect(parse(file, false)).rejects.toThrow(/setMeshoptDecoder must be called before loading compressed files/);
}, 120_000);

it.each(REQUIRED)("%s loads through the decoder-configured loader", async (file) => {
  const g = await parse(file, true);
  let meshes = 0;
  g.scene.traverse((o) => { if ((o as T.Mesh).isMesh) meshes++; });
  expect(meshes).toBeGreaterThan(0);
}, 120_000);
