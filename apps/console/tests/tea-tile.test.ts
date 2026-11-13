// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { buildDoor } from "../src/features/world/TeaDoorLeaf";

// The shipped tea tile (tools/city3/build_tiles.sh) must still carry everything the runtime edits: the door instance + its Props panels
// (TeaDoorLeaf) and the lift's four door placeholders (TeaElevator). Skipped where the generated tiles are not checked out.
const assets = new URL("../public/assets/tiles/", import.meta.url);
const manifest = existsSync(new URL("districts.json", assets)) ? JSON.parse(readFileSync(new URL("districts.json", assets), "utf8")) : null;
const tea = manifest?.districts.find((d: { id: string }) => d.id === "tea");
describe.skipIf(!tea)("tea tile", () => {
  it("builds the door leaf and holds all four lift door placeholders", async () => {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    loader.register(() => ({ name: "stub", loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()) })); // geometry only
    const b = readFileSync(new URL(tea.url.replace("/assets/tiles/", ""), assets));
    const scene = (await loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "")).scene;
    scene.updateMatrixWorld(true);
    let lifts = 0; scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.userData.elevatorDoor) lifts++; });
    expect(lifts).toBe(4);
    const built = buildDoor(scene);
    expect(built).not.toBeNull();
    built?.restore();
  });
});
