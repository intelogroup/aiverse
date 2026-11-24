import * as THREE from "three";

/**
 * The district world's static atmosphere rig: gradient sky dome (custom shader), the ocean
 * plane that replaces the GLBs' legacy water, the hemisphere fill, and the cloud layer
 * (procedural sprite puffs on a camera-following ring). Construction only —
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

// Hemisphere fill (bright-daylight tune, 2026-11-23): sky bounce is daylight
// blue, ground bounce a neutral earth, so shade reads as open-air shadow
// instead of the old golden-hour gloom. Intensity comes from the theme's
// ambient field in the frame loop.
export function createHemiFill() {
  const h = new THREE.HemisphereLight();
  h.color.setRGB(0.72, 0.83, 1.0); h.groundColor.setRGB(0.45, 0.44, 0.4); h.intensity = 0;
  return h;
}

// --- Clouds -----------------------------------------------------------------
// Cheap fair-weather cumulus: one procedural puff sprite (a DataTexture of
// summed gaussian blobs — no image asset, no DOM canvas, so it builds the
// same in tests) shared by a ring of camera-facing sprites. The group follows
// the camera like the sky dome and drifts slowly (DistrictWorld drives both),
// so the layer reads as sky, not scenery. Sprites ignore fog so they stay
// white at distance.
// PLACEMENT CONSTRAINT (measured 2026-11-23): the ring must live INSIDE
// ~450 m of the follow origin. The agents' vision camera (ScoutVision) has a
// 500 m far plane, and the first cut of this layer ringed sprites at
// 480–1730 m — geometrically present in the live view, but clipped from every
// scout capture and effectively invisible in stills. Ring radius 170–430 m,
// tops at 95–170 m: low enough to sit in the sky band of ground-level views,
// high enough to clear every rooftop.

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function createCloudTexture() {
  const W = 256, H = 128;
  const rand = lcg(20261123);
  const blobs: { x: number; y: number; r: number; a: number }[] = [];
  for (let i = 0; i < 30; i++) {
    blobs.push({ x: 34 + rand() * (W - 68), y: 46 + rand() * 36, r: 15 + rand() * 26, a: 0.5 + rand() * 0.5 });
  }
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (const b of blobs) {
        const dx = (x - b.x) / b.r, dy = (y - b.y) / (b.r * 0.62);
        s += b.a * Math.exp(-(dx * dx + dy * dy) * 2.2);
      }
      // Window the sprite so its rectangular edge can never show.
      const wx = Math.sin((x / W) * Math.PI), wy = Math.sin((y / H) * Math.PI);
      const a = Math.min(1, s) * wx * wy;
      const smooth = a * a * (3 - 2 * a);
      const idx = (y * W + x) * 4;
      data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255;
      data[idx + 3] = Math.round(255 * Math.min(1, smooth * 1.35));
    }
  }
  const tex = new THREE.DataTexture(data, W, H);
  tex.needsUpdate = true;
  return tex;
}

export function createCloudLayer() {
  const tex = createCloudTexture();
  const group = new THREE.Group();
  const rand = lcg(7117);
  const COUNT = 26;
  for (let i = 0; i < COUNT; i++) {
    const angle = (i / COUNT) * Math.PI * 2 + rand() * 0.5;
    const radius = 170 + rand() * 260;
    const w = 150 + rand() * 190;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, opacity: 0.62 + rand() * 0.33 });
    const sp = new THREE.Sprite(mat);
    sp.position.set(Math.cos(angle) * radius, 95 + rand() * 75, Math.sin(angle) * radius);
    sp.scale.set(w, w * 0.36, 1);
    sp.renderOrder = -900;
    group.add(sp);
  }
  // Postcard sprites (2026-11-23): four fixed puffs on the northern sky —
  // the city→villa axis the proof stills (and players) look along. The
  // random ring alone left the from-city frame's narrow sky band empty in
  // the first daylight stills while the ground view was full of cloud;
  // these offsets are placed to sit at 15–20° elevation from both the
  // from-city and ground viewpoints, inside the 500 m scout far plane.
  const postcard: { p: [number, number, number]; w: number; o: number }[] = [
    { p: [-180, 133, 330], w: 300, o: 0.9 },
    { p: [40, 128, 390], w: 340, o: 0.95 },
    { p: [190, 138, 330], w: 280, o: 0.85 },
    { p: [-60, 118, 430], w: 320, o: 0.88 },
  ];
  for (const c of postcard) {
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, opacity: c.o });
    const sp = new THREE.Sprite(mat);
    sp.position.set(c.p[0], c.p[1], c.p[2]);
    sp.scale.set(c.w, c.w * 0.36, 1);
    sp.renderOrder = -900;
    group.add(sp);
  }
  group.frustumCulled = false;
  return group;
}

export function disposeCloudLayer(group: THREE.Group) {
  const mats: THREE.SpriteMaterial[] = [];
  group.traverse((o) => {
    const sp = o as THREE.Sprite;
    if (sp.isSprite) mats.push(sp.material as THREE.SpriteMaterial);
  });
  const tex = mats[0]?.map ?? null;
  mats.forEach((m) => m.dispose());
  tex?.dispose();
}
