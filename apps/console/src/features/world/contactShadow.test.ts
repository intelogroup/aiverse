import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { contactPoints } from "./grounding";
import { contactShadowOpacity, createFootContactShadows } from "./contactShadow";

describe("foot contact shadows", () => {
  it("fades with actual foot flight height instead of sticking to a running foot", () => {
    expect(contactShadowOpacity(0)).toBe(0.28);
    expect(contactShadowOpacity(-0.01)).toBe(0.28);
    expect(contactShadowOpacity(0.08)).toBeCloseTo(0.07);
    expect(contactShadowOpacity(0.16)).toBe(0);
    expect(contactShadowOpacity(1)).toBe(0);
  });
  it("holds the shadow on the floor despite rig grounding and a translated parent", () => {
    const world = new THREE.Group(); world.position.y = 0.48;
    const figure = new THREE.Group(); world.add(figure);
    const scene = new THREE.Group(); scene.scale.setScalar(1.5); figure.add(scene);
    const foot = new THREE.Bone(); foot.name = "mixamorigLeftFoot"; foot.position.set(0.1, 0.06, 0);
    scene.add(foot);
    const points = contactPoints(scene);
    const shadows = createFootContactShadows(points, 1.5); figure.add(shadows.group);
    foot.position.y += 0.02;
    figure.position.y = -0.03; // grounding cancels the 3 cm world-space lift
    shadows.update(scene, figure, 0, true);
    world.updateMatrixWorld(true);
    const mesh = shadows.group.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    expect(mesh.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(0.484);
    expect(mesh.material.opacity).toBeCloseTo(0.28);
    foot.position.y += 0.1;
    shadows.update(scene, figure, 0, true);
    expect(mesh.material.opacity).toBeLessThan(0.002);
    shadows.update(scene, figure, 0, false);
    expect(shadows.group.visible).toBe(false);
    shadows.dispose();
  });
});
