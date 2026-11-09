import * as THREE from "three";

/** RGB and depth come from one render, so moving bodies cannot disagree between modalities.
 * Depth is positive camera-axis distance in metres, top-left row-major; 0 means sky/no depth-writing surface.
 * Transparent materials with depthWrite=false are deliberately absent from this surface map.
 */
export interface ScoutVisionFrame {
  image: string;
  depth: { width: number; height: number; units: "m"; convention: "camera-z"; invalid: 0; values: number[] };
  camera: { width: number; height: number; near: number; far: number; fx: number; fy: number; cx: number; cy: number; worldFromCamera: number[]; projection: number[] };
  simulationTime: number;
}

/** Inverse of Three r170 packing.glsl.js unpackRGBAToDepth, using byte-valued channels. */
export function unpackDepth(r: number, g: number, b: number, a: number): number {
  return r / 256 + g / 65536 + b / 16777216 + a / (255 * 16777216);
}

export function metricDepth(depth: number, near: number, far: number): number {
  if (!Number.isFinite(depth) || depth >= 1 || depth < 0) return 0;
  return near * far / (far - depth * (far - near));
}

export function decodeDepth(pixels: Uint8Array, width: number, height: number, near: number, far: number): number[] {
  const values = new Array<number>(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = ((height - 1 - y) * width + x) * 4;
    const z = metricDepth(unpackDepth(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]), near, far);
    values[y * width + x] = z === 0 ? 0 : Math.round(z * 1000) / 1000;
  }
  return values;
}

export function cameraCalibration(camera: THREE.PerspectiveCamera, width: number, height: number): ScoutVisionFrame["camera"] {
  camera.updateMatrixWorld();
  const p = camera.projectionMatrix.elements;
  return { width, height, near: camera.near, far: camera.far, fx: p[0] * width / 2, fy: p[5] * height / 2,
    cx: (1 - p[8]) * width / 2, cy: (1 + p[9]) * height / 2,
    worldFromCamera: camera.matrixWorld.toArray(), projection: camera.projectionMatrix.toArray() };
}

/** Conservative point visibility, not recognition: no out-of-frustum or hidden landmark centres leak into look(). */
export function pointVisible(point: THREE.Vector3, camera: THREE.PerspectiveCamera, depth: ScoutVisionFrame["depth"], tolerance = 0.25): boolean {
  const local = point.clone().applyMatrix4(camera.matrixWorldInverse);
  const z = -local.z;
  if (z < camera.near || z >= camera.far) return false;
  const ndc = point.clone().project(camera);
  if (Math.abs(ndc.x) >= 1 || Math.abs(ndc.y) >= 1) return false;
  const x = Math.floor((ndc.x + 1) * depth.width / 2);
  const y = Math.floor((1 - ndc.y) * depth.height / 2);
  const seen = depth.values[y * depth.width + x];
  // No depth hit is unknown, not proof that a semantic object is visible.
  return seen > 0 && z <= seen + tolerance;
}

export class ScoutVision {
  readonly camera: THREE.PerspectiveCamera;
  private readonly color: THREE.WebGLRenderTarget;
  private readonly packed: THREE.WebGLRenderTarget;
  private readonly copyScene = new THREE.Scene();
  private readonly copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly copyMaterial: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly rgba: Uint8Array;
  private readonly depthBytes: Uint8Array;

  readonly width: number;
  readonly height: number;
  constructor(width = 512, height = 288) {
    this.width = width; this.height = height;
    this.camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 500);
    this.color = new THREE.WebGLRenderTarget(width, height);
    this.color.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
    this.packed = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: { sourceDepth: { value: this.color.depthTexture } },
      vertexShader: "varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}",
      fragmentShader: "#include <packing>\nuniform sampler2D sourceDepth; varying vec2 vUv; void main(){gl_FragColor=packDepthToRGBA(texture2D(sourceDepth,vUv).x);}",
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMaterial);
    this.copyScene.add(this.quad);
    this.rgba = new Uint8Array(width * height * 4);
    this.depthBytes = new Uint8Array(width * height * 4);
  }

  capture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, simulationTime: number, hidden?: THREE.Object3D | null): ScoutVisionFrame {
    const priorTarget = renderer.getRenderTarget();
    const priorVisible = hidden?.visible;
    const priorAutoClear = renderer.autoClear;
    if (hidden) hidden.visible = false;
    this.camera.updateMatrixWorld();
    try {
      renderer.autoClear = true;
      renderer.setRenderTarget(this.color);
      renderer.render(scene, this.camera);
      renderer.readRenderTargetPixels(this.color, 0, 0, this.width, this.height, this.rgba);
      renderer.setRenderTarget(this.packed);
      renderer.render(this.copyScene, this.copyCamera);
      renderer.readRenderTargetPixels(this.packed, 0, 0, this.width, this.height, this.depthBytes);
    } finally {
      renderer.setRenderTarget(priorTarget);
      renderer.autoClear = priorAutoClear;
      if (hidden && priorVisible !== undefined) hidden.visible = priorVisible;
    }
    const canvas = document.createElement("canvas");
    canvas.width = this.width; canvas.height = this.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Scout image encoding unavailable");
    const image = ctx.createImageData(this.width, this.height);
    const stride = this.width * 4;
    for (let y = 0; y < this.height; y++) image.data.set(this.rgba.subarray((this.height - 1 - y) * stride, (this.height - y) * stride), y * stride);
    ctx.putImageData(image, 0, 0);
    return { image: canvas.toDataURL("image/png"), depth: { width: this.width, height: this.height, units: "m", convention: "camera-z", invalid: 0,
      values: decodeDepth(this.depthBytes, this.width, this.height, this.camera.near, this.camera.far) },
      camera: cameraCalibration(this.camera, this.width, this.height), simulationTime };
  }

  dispose(): void {
    this.color.dispose(); this.packed.dispose(); this.copyMaterial.dispose(); this.quad.geometry.dispose();
  }
}

export interface RouteImagePoint {
  world: [number, number, number];
  pixel: [number, number] | null;
  visibility: "visible" | "occluded" | "outside" | "unknown";
}

/** Project route vertices with the exact observation camera. Hidden route portions must be drawn differently,
 * never as visible ground. Subdivide long segments before rendering so an occluder between vertices is sampled.
 */
export function projectRoute(points: readonly (readonly [number, number, number])[], frame: Pick<ScoutVisionFrame, "camera" | "depth">): RouteImagePoint[] {
  const c = frame.camera;
  const view = new THREE.Matrix4().fromArray(c.worldFromCamera).invert();
  const projection = new THREE.Matrix4().fromArray(c.projection);
  return points.map(p => {
    const world: [number, number, number] = [p[0], p[1], p[2]];
    const local = new THREE.Vector3(...p).applyMatrix4(view);
    const z = -local.z;
    const ndc = local.clone().applyMatrix4(projection);
    if (z < c.near || z >= c.far || Math.abs(ndc.x) >= 1 || Math.abs(ndc.y) >= 1) return { world, pixel: null, visibility: "outside" };
    const pixel: [number, number] = [(ndc.x + 1) * c.width / 2, (1 - ndc.y) * c.height / 2];
    const x = Math.floor(pixel[0] * frame.depth.width / c.width), y = Math.floor(pixel[1] * frame.depth.height / c.height);
    const depth = frame.depth.values[y * frame.depth.width + x];
    return { world, pixel, visibility: depth <= 0 || !Number.isFinite(depth) ? "unknown" : z <= depth + .25 ? "visible" : "occluded" };
  });
}

/** Draw only depth-confirmed segments over the captured RGB frame. */
export async function renderRouteOverlay(frame: ScoutVisionFrame, points: [number, number, number][]): Promise<string> {
  const samples: [number, number, number][] = points.slice(0, 1);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.2));
    for (let j = 1; j <= count; j++) {
      const t = j / count;
      samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  const projected = projectRoute(samples, frame);
  const image = new Image();
  image.src = frame.image;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = frame.camera.width;
  canvas.height = frame.camera.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return frame.image;
  ctx.drawImage(image, 0, 0);
  ctx.beginPath();
  for (let i = 1; i < projected.length; i++) {
    const a = projected[i - 1], b = projected[i];
    if (a.visibility !== "visible" || b.visibility !== "visible" || !a.pixel || !b.pixel) continue;
    ctx.moveTo(...a.pixel);
    ctx.lineTo(...b.pixel);
  }
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#152b22";
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#52ffa5";
  ctx.stroke();
  return canvas.toDataURL("image/png");
}
