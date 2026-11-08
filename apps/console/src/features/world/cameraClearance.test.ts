import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildColliders } from "./CameraCollider";
import { CameraClearance, registerCameraObstacle } from "./cameraClearance";

describe("camera geometry coverage", () => {
  it("includes instanced awnings and props", () => {
    const root = new THREE.Group();
    const awning = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 0.1, 2), new THREE.MeshBasicMaterial(), 1);
    awning.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 2, 0));
    root.add(awning);
    expect(buildColliders(root).meshes).toContain(awning);
  });
  it("preserves transformed instance hits while using the geometry BVH", () => {
    const root = new THREE.Group();
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 3);
    mesh.position.x = 4;
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 3));
    mesh.setMatrixAt(1, new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 6), new THREE.Quaternion(), new THREE.Vector3(2, 2, 2)));
    mesh.setMatrixAt(2, new THREE.Matrix4().makeScale(0, 0, 0));
    root.add(mesh);
    root.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(4, 0, 0), new THREE.Vector3(0, 0, 1), 0, 10);
    const before = ray.intersectObject(mesh).map(h => [h.instanceId, h.distance]);
    buildColliders(root);
    expect(ray.intersectObject(mesh).map(h => [h.instanceId, h.distance])).toEqual(before);
    ray.far = 2;
    expect(ray.intersectObject(mesh)).toHaveLength(0);
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 1));
    mesh.instanceMatrix.needsUpdate = true;
    expect(ray.intersectObject(mesh)[0].distance).toBeCloseTo(0.5);
    mesh.position.x = 20;
    mesh.updateMatrixWorld();
    expect(ray.intersectObject(mesh)).toHaveLength(0);
  });
});

describe("near-plane clearance", () => {
  const target = new THREE.Vector3();
  const desired = new THREE.Vector3(0, 0, 5);
  const camera = new THREE.PerspectiveCamera(60, 2, 0.2, 100);
  it("catches an obstacle at the edge even when the centre ray misses", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 0.1), new THREE.MeshBasicMaterial());
    mesh.position.set(0.23, 0, 2);
    mesh.updateMatrixWorld();
    const centre = new THREE.Raycaster(target, desired.clone().normalize(), 0, 5);
    expect(centre.intersectObject(mesh)).toHaveLength(0);
    expect(new CameraClearance().hitDistance(target, desired, camera, [mesh])).toBeCloseTo(1.95);
  });
  it("blocks the back side of an awning without changing its rendering material", () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
    mesh.position.z = 2;
    mesh.updateMatrixWorld();
    expect(new THREE.Raycaster(target, desired.clone().normalize()).intersectObject(mesh)).toHaveLength(0);
    expect(new CameraClearance().hitDistance(target, desired, camera, [mesh])).toBeCloseTo(2);
    expect(mesh.material.side).toBe(THREE.FrontSide);
  });
  it("tracks moving door geometry and removes it on cleanup", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.1), new THREE.MeshBasicMaterial());
    mesh.position.z = 2;
    const unregister = registerCameraObstacle(mesh);
    const clearance = new CameraClearance();
    expect(clearance.hitDistance(target, desired, camera, [])).toBeCloseTo(1.95);
    mesh.position.x = 10;
    expect(clearance.hitDistance(target, desired, camera, [])).toBeNull();
    mesh.position.x = 0;
    unregister();
    expect(clearance.hitDistance(target, desired, camera, [])).toBeNull();
  });
});
