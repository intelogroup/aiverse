import * as THREE from "three";

/**
 * The district world's static atmosphere rig: gradient sky dome (custom shader), the ocean
 * plane that replaces the GLBs' legacy water, and the warm hemisphere fill. Construction only —
 * DistrictWorld owns the instances and drives their uniforms and colors from the blended
 * district theme each frame.
 */
const SKY_VERT = `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`;
const SKY_FRAG = `varying vec3 vDir; uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunCol;
void main(){ float h = clamp(vDir.y, -0.2, 1.0); vec3 c = mix(horizon, top, pow(max(h,0.0), 0.55));
  c = mix(c, horizon * 0.8, smoothstep(0.0, -0.2, vDir.y));
  float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0); c += sunCol * (pow(s, 600.0) * 4.0 + pow(s, 8.0) * 0.28);
  gl_FragColor = vec4(c, 1.0); }`;

export function createSkyDome() {
  const mat = new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() } } });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat); mesh.frustumCulled = false; mesh.renderOrder = -1000; mesh.scale.setScalar(2500);
  return mesh;
}

export function createOcean() {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshStandardMaterial({ color: "#1c6a84", roughness: 0.12, metalness: 0.0 }));
  m.rotation.x = -Math.PI / 2; m.position.y = -1.25; m.receiveShadow = true; return m;
}

// Warm hemisphere fill (deeper-grade tune): with envIntensity lowered the
// RoomEnvironment wash no longer flattens the palette, and this fill —
// sky warm, ground earth — keeps shade readable without desaturating it.
// Intensity comes from the theme's ambient field in the frame loop.
export function createHemiFill() {
  const h = new THREE.HemisphereLight();
  h.color.setRGB(1.0, 0.85, 0.62); h.groundColor.setRGB(0.45, 0.36, 0.22); h.intensity = 0;
  return h;
}
