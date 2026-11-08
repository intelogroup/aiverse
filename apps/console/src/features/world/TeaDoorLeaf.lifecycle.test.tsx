import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TEA_DOOR_ORIGIN, TEA_GROUND_Y, TeaDoorController } from "./teaDoor";

const fixture = vi.hoisted(() => ({ scene: null as unknown as THREE.Group }));
vi.mock("@react-three/drei", () => ({ useGLTF: () => fixture }));
vi.mock("@react-three/fiber", () => ({ useFrame: () => {} }));
import { TeaDoorLeaf } from "./TeaDoorLeaf";

it("keeps static leaves removed through StrictMode cleanup/remount, restoring on unmount", () => {
  const scene = new THREE.Group(); fixture.scene = scene;
  const instance = new THREE.InstancedMesh(new THREE.BoxGeometry(.5, 1, .02), new THREE.MeshBasicMaterial(), 7);
  instance.name = "inst_door_double";
  instance.setMatrixAt(6, new THREE.Matrix4().makeTranslation(TEA_DOOR_ORIGIN.x, TEA_GROUND_Y, TEA_DOOR_ORIGIN.z));
  scene.add(instance);
  const pieces = [-.36, .36].map(x => new THREE.BoxGeometry(.68, 2, .06).translate(TEA_DOOR_ORIGIN.x + x, TEA_GROUND_Y + 1.35, TEA_DOOR_ORIGIN.z - .21));
  const original = mergeGeometries(pieces);
  const panels = new THREE.Mesh(original, new THREE.MeshBasicMaterial()); panels.name = "Props"; scene.add(panels);
  const controller = new TeaDoorController({ channel: { fireDoor: () => true, doorPlaying: false }, setBlocker: () => {} });
  const mounted = render(<StrictMode><TeaDoorLeaf controller={controller} /></StrictMode>);
  expect(panels.geometry).not.toBe(original);
  expect(panels.geometry.index!.count).toBe(0);
  const matrix = new THREE.Matrix4(); instance.getMatrixAt(6, matrix);
  expect(matrix.elements[0]).toBe(0);
  mounted.unmount();
  expect(panels.geometry).toBe(original);
  instance.getMatrixAt(6, matrix); expect(matrix.elements[0]).toBe(1);
});
