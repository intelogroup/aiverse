import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { pointEnclosed } from "./cameraClearance";

const mesh = (geo: THREE.BufferGeometry, pos: [number, number, number] = [0, 0, 0]) => {
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  m.position.set(...pos);
  m.updateMatrixWorld(true);
  return m;
};

describe("pointEnclosed", () => {
  it("is true inside a closed solid (the fountain tower case)", () => {
    const tower = mesh(new THREE.BoxGeometry(6.4, 36, 6.4), [0, 18, 0]);
    expect(pointEnclosed(new THREE.Vector3(0, 8, 0), [tower])).toBe(true);
  });

  it("is true inside a solid that has no bottom face, standing on a ground plane", () => {
    const box = new THREE.BoxGeometry(6, 20, 6).toNonIndexed();
    const pos = box.getAttribute("position");
    const keep: number[] = [];
    // drop the -Y face (both triangles whose vertices all sit at y = -10)
    for (let i = 0; i < pos.count; i += 3) if (![0, 1, 2].every((k) => pos.getY(i + k) === -10)) for (let k = 0; k < 3; k++) keep.push(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k));
    const open = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(keep, 3));
    open.computeVertexNormals();
    const ground = mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2));
    expect(pointEnclosed(new THREE.Vector3(0, 5, 0), [mesh(open, [0, 10, 0]), ground])).toBe(true);
  });

  it("is false outside the solid and under an open awning", () => {
    const tower = mesh(new THREE.BoxGeometry(6.4, 36, 6.4), [0, 18, 0]);
    expect(pointEnclosed(new THREE.Vector3(10, 8, 10), [tower])).toBe(false);
    const awning = mesh(new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2), [20, 3, 20]);
    expect(pointEnclosed(new THREE.Vector3(20, 1.5, 20), [awning, tower])).toBe(false);
  });

  it("restores every material's side", () => {
    const tower = mesh(new THREE.BoxGeometry(2, 2, 2));
    pointEnclosed(new THREE.Vector3(0, 0, 0), [tower]);
    expect((tower.material as THREE.Material).side).toBe(THREE.FrontSide);
  });
});
