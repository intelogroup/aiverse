import { expect, it } from "vitest";
import * as THREE from "three";
import { cloneVillaScene } from "./villaMaterials";

it("refinishes a Villa instance without editing the source geometry or material", () => {
  const texture = new THREE.Texture();
  const lawn = new THREE.MeshStandardMaterial({ name: "grass 01", map: texture, metalness: 1 });
  const glass = new THREE.MeshStandardMaterial({ name: "glass 01", color: 0x000000 });
  const geometry = new THREE.PlaneGeometry();
  const source = new THREE.Group();
  source.add(new THREE.Mesh(geometry, [lawn, glass]), new THREE.Mesh(geometry, lawn));

  const villa = cloneVillaScene(source);
  const [landscape, second] = villa.children as [THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>, THREE.Mesh];
  const [turf, glazing] = landscape.material;

  expect(landscape.geometry).toBe(geometry);
  expect(turf).toBe(second.material);
  expect(turf).not.toBe(lawn);
  expect(turf.map).toBe(texture);
  expect(turf.color.g).toBeGreaterThan(turf.color.r);
  expect(turf.metalness).toBe(0);
  expect(lawn.metalness).toBe(1);
  expect(glazing.color.b).toBeGreaterThan(0);
  expect(glazing.transparent).toBe(false);
  expect(glass.color.getHex()).toBe(0x000000);
});
