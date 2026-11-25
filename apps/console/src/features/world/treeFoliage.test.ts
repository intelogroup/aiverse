import { expect, it } from "vitest";
import * as THREE from "three";
import { softenTreeFoliage } from "./districtTree";

it("adds textured fill to masked tree leaves without changing the cutout", () => {
  const map = new THREE.Texture();
  const leaves = new THREE.MeshStandardMaterial({
    name: "Tree_Branches_01.001",
    map,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });
  softenTreeFoliage(leaves);
  const version = leaves.version;
  softenTreeFoliage(leaves);
  expect(leaves.emissiveMap).toBe(map);
  expect(leaves.emissiveIntensity).toBeGreaterThan(0);
  expect(leaves.version).toBe(version);
  expect(leaves.alphaTest).toBe(0.5);
  expect(leaves.side).toBe(THREE.DoubleSide);
});

it("preserves trunk materials and authored emissive maps", () => {
  const map = new THREE.Texture();
  const authored = new THREE.Texture();
  const trunk = new THREE.MeshStandardMaterial({ name: "Tree_Trunk_01", map });
  const leaves = new THREE.MeshStandardMaterial({
    name: "Tree_Branches_02",
    map,
    alphaTest: 0.5,
    emissiveMap: authored,
  });
  softenTreeFoliage(trunk);
  softenTreeFoliage(leaves);
  expect(trunk.emissiveMap).toBeNull();
  expect(leaves.emissiveMap).toBe(authored);
});
