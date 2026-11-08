import * as THREE from "three";
import type { ContactPoint } from "./grounding";

/** Local contact cue: independent of the city-wide sun map (440 m across).
 * Fades out during flight; never changes the rig's measured grounding. */
export function contactShadowOpacity(clearance: number): number {
  return 0.28 * Math.max(0, 1 - Math.max(0, clearance) / 0.16) ** 2;
}

export function createFootContactShadows(points: readonly ContactPoint[], scale: number) {
  const size = 32;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
    const alpha = Math.round(255 * Math.max(0, 1 - r) ** 2);
    const at = (y * size + x) * 4;
    pixels[at] = pixels[at + 1] = pixels[at + 2] = 255;
    pixels[at + 3] = alpha;
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.needsUpdate = true;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  const geometry = new THREE.PlaneGeometry(0.23 * scale, 0.36 * scale).rotateX(-Math.PI / 2);
  const group = new THREE.Group();
  group.name = "foot-contact-shadows";
  // One mark per ankle, not one for every toe joint.
  const feet = points.filter(p => /(?:Left|Right)Foot$|^foot\.?[lr]$/.test(p.bone.name));
  const marks = feet.map(point => {
    const material = new THREE.MeshBasicMaterial({ color: 0x000000, map: texture, transparent: true,
      depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.raycast = () => {}; // visual cue, never a camera or walker obstacle
    mesh.userData.contactShadow = true;
    group.add(mesh);
    return { point, mesh, material };
  });
  const position = new THREE.Vector3();
  const sceneInverse = new THREE.Matrix4();
  const figureInverse = new THREE.Matrix4();
  return {
    group,
    update(scene: THREE.Object3D, figure: THREE.Object3D, floorY: number, visible: boolean) {
      group.visible = visible;
      if (!visible) return;
      figure.updateWorldMatrix(true, true);
      sceneInverse.copy(scene.matrixWorld).invert();
      figureInverse.copy(figure.matrixWorld).invert();
      for (const { point, mesh, material } of marks) {
        position.setFromMatrixPosition(point.bone.matrixWorld).applyMatrix4(sceneInverse);
        const clearance = (position.y - point.restY) * scale + figure.position.y - floorY;
        material.opacity = contactShadowOpacity(clearance);
        position.setFromMatrixPosition(point.bone.matrixWorld).applyMatrix4(figureInverse);
        mesh.position.set(position.x, floorY - figure.position.y + 0.004, position.z);
      }
    },
    dispose() {
      geometry.dispose(); texture.dispose();
      for (const { material } of marks) material.dispose();
    },
  };
}
