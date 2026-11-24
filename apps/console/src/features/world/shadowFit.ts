import * as THREE from "three";

/** Shadow frustum half-size: tight around a walker, the whole city from the air. */
export const WALK_HALF = 60, AERIAL_HALF = 220, AERIAL_Y = 60;

/**
 * Where the key light's ortho shadow box sits and how big it is. One map over the whole 440 m city gave 21-43 cm per shadow texel
 * (the tier drops the map to 1024), so with PCF soft filtering houses and trees cast nothing visible. Walking, the box is +-60 m and
 * pushed ahead of the camera; from the air it is the whole city. The centre is snapped to whole texels in light space, so the shadow
 * edges do not crawl as the camera moves (the standard stable-shadow-map trick).
 */
export function shadowBox(cam: { x: number; y: number; z: number; fx: number; fz: number }, sunDir: THREE.Vector3, mapSize: number) {
  const aerial = cam.y > AERIAL_Y;
  const half = aerial ? AERIAL_HALF : WALK_HALF;
  const fl = Math.hypot(cam.fx, cam.fz) || 1;
  const c = aerial ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(cam.x + (cam.fx / fl) * half * 0.6, 0, cam.z + (cam.fz / fl) * half * 0.6);
  const z = sunDir.clone().normalize();
  const x = new THREE.Vector3(0, 1, 0).cross(z).normalize(); const y = z.clone().cross(x);
  const texel = (2 * half) / mapSize;
  const a = Math.round(c.dot(x) / texel) * texel, b = Math.round(c.dot(y) / texel) * texel, d = c.dot(z);
  const center = x.multiplyScalar(a).add(y.multiplyScalar(b)).add(z.clone().multiplyScalar(d));
  return { center, half, texel };
}

const fwd = new THREE.Vector3();
/** Fit the key light's shadow box to the camera (call every frame). */
export function fitShadow(l: THREE.DirectionalLight, sunDir: THREE.Vector3, camera: THREE.Camera) {
  camera.getWorldDirection(fwd);
  const { center, half, texel } = shadowBox({ x: camera.position.x, y: camera.position.y, z: camera.position.z, fx: fwd.x, fz: fwd.z }, sunDir, l.shadow.mapSize.width || 2048);
  l.target.position.copy(center); l.target.updateMatrixWorld();
  l.position.copy(center).addScaledVector(sunDir, 400);
  const sc = l.shadow.camera;
  if (sc.right !== half) {
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.updateProjectionMatrix();
  }
  l.shadow.normalBias = texel * 1.5;   // was 0.8 m: that pushed every shadow off its caster (houses read as floating)
  l.shadow.bias = -0.0005;
}
