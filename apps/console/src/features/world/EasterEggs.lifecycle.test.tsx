import { StrictMode } from "react";
import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import * as THREE from "three";

const fixture = vi.hoisted(() => ({
  model: null as unknown as THREE.Group,
  scene: null as unknown as THREE.Scene,
  camera: null as unknown as THREE.PerspectiveCamera,
  frame: null as unknown as (state: unknown, dt: number) => void,
}));
vi.mock("@react-three/drei", () => ({ useGLTF: () => ({ scene: fixture.model }) }));
vi.mock("@react-three/fiber", () => ({
  useThree: () => ({ scene: fixture.scene, camera: fixture.camera }),
  useFrame: (callback: typeof fixture.frame) => { fixture.frame = callback; },
}));
import { EasterEggs } from "./EasterEggs";

it("preserves stable IDs while culling by distance/district and releases owned buffers through StrictMode", async () => {
  fixture.scene = new THREE.Scene();
  fixture.camera = new THREE.PerspectiveCamera();
  fixture.model = new THREE.Group();
  const geometry = new THREE.SphereGeometry(.2, 8, 8);
  const material = new THREE.MeshStandardMaterial();
  fixture.model.add(new THREE.Mesh(geometry, material));
  const geometryDispose = vi.spyOn(geometry, "dispose");
  const materialDispose = vi.spyOn(material, "dispose");
  const instanceDispose = vi.spyOn(THREE.InstancedMesh.prototype, "dispose");
  const placements = [
    { id: "near", district: "bazaar", position: [2, .2, 0], rotationY: 0, scale: 1, hint: "" },
    { id: "far", district: "bazaar", position: [180, .2, 0], rotationY: 0, scale: 1, hint: "" },
    { id: "unloaded", district: "halo", position: [3, .2, 0], rotationY: 0, scale: 1, hint: "" },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ eggs: placements }) })));
  const mounted = render(<StrictMode><EasterEggs activeDistricts={["bazaar"]} /></StrictMode>);
  try {
    await waitFor(() => expect(fixture.scene.getObjectByName("hunt:easter-eggs")).toBeDefined());
    fixture.frame(null, .3);
    const root = fixture.scene.getObjectByName("hunt:easter-eggs")!;
    const meshes = root.children as THREE.InstancedMesh[];
    expect(meshes.flatMap(mesh => mesh.userData.eggIds)).toEqual(["near"]);
    fixture.camera.position.x = 180;
    fixture.frame(null, .3);
    expect(meshes.flatMap(mesh => mesh.userData.eggIds)).toEqual(["far"]);
    mounted.rerender(<StrictMode><EasterEggs activeDistricts={[]} /></StrictMode>);
    fixture.frame(null, .3);
    expect(meshes.every(mesh => !mesh.visible && mesh.count === 0)).toBe(true);
    mounted.unmount();
    expect(fixture.scene.getObjectByName("hunt:easter-eggs")).toBeUndefined();
    expect(instanceDispose).toHaveBeenCalled();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();
  } finally {
    mounted.unmount();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
