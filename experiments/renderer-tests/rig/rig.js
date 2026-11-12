import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const q = new URLSearchParams(location.search);
const backend = q.get('backend') || 'webgl';       // webgl | webgpu
const subject = q.get('subject') || 'world';       // world | jim
const W = 512, H = 288;

const info = { backend, subject, errors: [] };
window.addEventListener('error', e => info.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => { window.__stageError = String(e.reason && e.reason.stack || e.reason); });
window.__stage = 'module-start';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

let renderer;
if (backend === 'webgpu') {
  const { WebGPURenderer } = await import('three/webgpu');
  renderer = new WebGPURenderer({ canvas, antialias: true });
  if (renderer.init) await renderer.init();
  try {
    const adapter = await navigator.gpu.requestAdapter();
    info.adapter = adapter ? {
      vendor: adapter.info?.vendor, architecture: adapter.info?.architecture,
      device: adapter.info?.device, description: adapter.info?.description,
      isFallbackAdapter: adapter.isFallbackAdapter ?? adapter.info?.isFallbackAdapter,
    } : null;
  } catch (e) { info.adapterError = String(e); }
} else {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  info.rendererString = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  info.glVersion = gl.getParameter(gl.VERSION);
}
renderer.setSize(W, H);
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 600);

const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x9a8a70, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
sun.position.set(40, 60, 25);
scene.add(sun);
try {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  info.environment = 'RoomEnvironment';
} catch (e) { info.environment = 'none: ' + String(e).slice(0, 120); }

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
try {
  const ktx2 = new KTX2Loader()
    .setTranscoderPath('/rig/node_modules/three/examples/jsm/libs/basis/')
    .detectSupport(renderer);
  loader.setKTX2Loader(ktx2);
  info.ktx2 = 'enabled';
} catch (e) { info.ktx2 = 'FAILED: ' + String(e).slice(0, 160); }

window.__stage = 'renderer-up';
const loadStart = performance.now();
window.__stage = 'loading-glb';
if (subject === 'world') {
  scene.background = new THREE.Color(0x9fc3e8);
  const gltf = await loader.loadAsync('/assets/world-city3.glb');
  scene.add(gltf.scene);
  // Fixed viewpoint: the proven Mira/Tea House pose (look-service index.jsonl,
  // 2026-11-10): pos [-26.19, 0.2, -63.96], heading 155 deg, Tea House
  // (shop-102) 8.62 m ahead. Eye = ground + 1.55 m.
  const pos = new THREE.Vector3(-26.19, 0.2 + 1.55, -63.96);
  const h = THREE.MathUtils.degToRad(155);
  const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
  camera.position.copy(pos);
  camera.lookAt(pos.clone().add(fwd));
  info.pose = { pos: [-26.19, 0.2, -63.96], headingDeg: 155, eye: 1.55 };
} else {
  scene.background = new THREE.Color(0x2e3238);
  const gltf = await loader.loadAsync('/assets/cast-jim.glb');
  scene.add(gltf.scene);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(3, 48),
    new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  camera.position.set(0.35, 1.42, 2.15);
  camera.lookAt(0, 1.02, 0);
  info.pose = { cam: [0.35, 1.42, 2.15], lookAt: [0, 1.02, 0] };
}
info.loadMs = Math.round(performance.now() - loadStart);
info.triangles = renderer.info.render.triangles;

const snap = document.createElement('canvas');
snap.width = W; snap.height = H;
const snapCtx = snap.getContext('2d');
// Captures render into an offscreen render target and read pixels back
// through the renderer (the same shape ScoutVision uses in production).
// A WebGPU *canvas* in headless Chromium never presents, so canvas
// readback (toBlob / drawImage) returns black even though draws succeed.
// Two r170 readback traps, both hit and diagnosed 2026-11-12:
//  (1) RenderTarget defaults to HalfFloatType (r152+) — unreadable into
//      a Uint8Array; pin UnsignedByteType.
//  (2) WebGLRenderer.readRenderTargetPixels rejects a plain
//      THREE.RenderTarget ("renderTarget is not THREE.WebGLRenderTarget")
//      and leaves the buffer zeroed; WebGL needs WebGLRenderTarget.
const rt = backend === 'webgpu'
  ? new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType })
  : new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType });
async function renderFrame() {
  renderer.setRenderTarget(rt);
  await renderer.render(scene, camera);
  renderer.setRenderTarget(null);
}
async function capture() {
  const t0 = performance.now();
  await renderFrame();
  const renderMs = performance.now() - t0;
  let px;
  if (backend === 'webgpu') {
    px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
  } else {
    px = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  }
  const img = snapCtx.createImageData(W, H);
  for (let y = 0; y < H; y++)
    img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  snapCtx.putImageData(img, 0, 0);
  const blob = await new Promise(r => snap.toBlob(r, 'image/png'));
  const buf = await blob.arrayBuffer();
  const totalMs = performance.now() - t0;
  let b64 = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000)
    b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { renderMs: Math.round(renderMs * 10) / 10, totalMs: Math.round(totalMs * 10) / 10,
           bytes: buf.byteLength, pngB64: btoa(b64) };
}

window.__stage = 'glb-loaded';
// warm-up renders (shader compile + texture upload happen here)
await renderFrame();
window.__stage = 'first-render-done';
await renderer.render(scene, camera);
info.triangles = renderer.info.render.triangles;
async function renderOnly() {
  const t0 = performance.now();
  renderer.setRenderTarget(null);
  await renderer.render(scene, camera);
  return Math.round((performance.now() - t0) * 10) / 10;
}
window.__rig = { info, capture, renderOnly };
window.__rigReady = true;
