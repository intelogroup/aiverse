// dissolve.ts — bodies materialize in and dissolve out instead of popping.
//
// When the sim ends a body (visit end, pause, kill, detach) the viewer stream
// just stops sending it, and the console used to unmount the figure the same
// frame. Here the figure lingers ~1.5 s while a shader burns it away, and a
// body that appears runs the same ramp backwards (materialize-in).
//
// The effect is a small onBeforeCompile injection into the body's own
// MeshStandardMaterials (pattern: ridelink0's three.js field notes §6, MIT;
// FBM field after dissolveit / r3f-dissolve-effect, MIT — see
// .build-tmp/dissolve-assets/REPORT.md):
//   - the field is procedural FBM over BIND-POSE object position
//     (vLocal = position), never UVs — the cast's UVs are costume atlases,
//     so a UV field would dissolve in atlas order, not body order;
//   - the field is height-biased, so the burn front sweeps feet-up as one
//     coherent front instead of uniform static;
//   - the cut is `discard`, never an alpha fade (no sorting artifacts on a
//     self-overlapping skinned body);
//   - the burn band is added into totalEmissiveRadiance with an HDR colour
//     so the scene bloom picks it up.
//
// Per-body isolation: every body owns one Dissolve (one uniforms object).
// CastFigure clones the shared GLB materials per figure before injecting,
// so dissolving one body can never touch another — the uniforms are the
// only channel, and they are never shared between Dissolve instances.
import * as THREE from "three";

/** Nominal seconds for a full solid→gone (or gone→solid) ramp. */
export const DISSOLVE_DURATION_S = 1.5;
// MathUtils.damp lambda tuned so progress settles (within SETTLE_EPS of the
// target) in about DISSOLVE_DURATION_S: ln(1/0.006) / 3.4 ≈ 1.50 s.
const DAMP_LAMBDA = 3.4;
const SETTLE_EPS = 0.006;

export interface DissolveUniforms {
  uProgress: { value: number };
  uEdgeWidth: { value: number };
  uEdgeColor: { value: THREE.Color };
  uNoiseScale: { value: number };
  uHeightBias: { value: number };
  uLocalMinY: { value: number };
  uLocalHeight: { value: number };
}

export interface Dissolve {
  uniforms: DissolveUniforms;
  /** Current damped progress: 0 = fully solid, 1 = fully dissolved. Starts at 1 — a body materializes in. */
  progress: number;
  /** Where progress is heading: 0 (present) or 1 (leaving). */
  target: 0 | 1;
  /** Advance the damp by dt seconds. Returns true once a leave has fully completed (settled at 1). */
  update(dt: number): boolean;
  /** Begin leaving (idempotent). */
  leave(): void;
  /** Cancel a leave / stay present (idempotent). */
  arrive(): void;
  /** True once fully gone (settled at 1). */
  readonly gone: boolean;
}

export function createDissolve(): Dissolve {
  const uniforms: DissolveUniforms = {
    uProgress: { value: 1 },
    // Field units: the burn band's width along the dissolve field.
    uEdgeWidth: { value: 0.05 },
    // Warm amber, HDR (×3) so the bloom pass catches the burn edge.
    uEdgeColor: { value: new THREE.Color("#ffb84d").multiplyScalar(3) },
    // FBM frequency over the height-normalized bind-pose position.
    uNoiseScale: { value: 3.0 },
    // 0 = pure noise static, 1 = a flat feet→head ramp. 0.35 sweeps coherently but stays organic.
    uHeightBias: { value: 0.35 },
    // Bind-pose geometry bounds, set by CastFigure per body (its meshes'
    // local space). Defaults describe a ~1.7 m body standing on y=0.
    uLocalMinY: { value: 0 },
    uLocalHeight: { value: 1.7 },
  };
  const d: Dissolve = {
    uniforms,
    progress: 1,
    target: 0,
    update(dt: number): boolean {
      d.progress = THREE.MathUtils.damp(d.progress, d.target, DAMP_LAMBDA, Math.max(0, dt));
      if (Math.abs(d.progress - d.target) < SETTLE_EPS) d.progress = d.target;
      uniforms.uProgress.value = d.progress;
      return d.target === 1 && d.progress === 1;
    },
    leave(): void {
      d.target = 1;
    },
    arrive(): void {
      d.target = 0;
    },
    get gone(): boolean {
      return d.target === 1 && d.progress === 1;
    },
  };
  return d;
}

// ---------------------------------------------------------------------------
// Shader injection
// ---------------------------------------------------------------------------

const VERT_HEAD = /* glsl */ `
varying vec3 vDisLocal;
`;
const VERT_BODY = /* glsl */ `
vDisLocal = position;
`;
const FRAG_HEAD = /* glsl */ `
varying vec3 vDisLocal;
uniform float uProgress;
uniform float uEdgeWidth;
uniform vec3 uEdgeColor;
uniform float uNoiseScale;
uniform float uHeightBias;
uniform float uLocalMinY;
uniform float uLocalHeight;
float disHash(vec3 p){ p = fract(p*0.3183099+vec3(0.71,0.113,0.419)); p*=17.0;
                        return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float disNoise(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(disHash(i+vec3(0,0,0)),disHash(i+vec3(1,0,0)),f.x),
                 mix(disHash(i+vec3(0,1,0)),disHash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(disHash(i+vec3(0,0,1)),disHash(i+vec3(1,0,1)),f.x),
                 mix(disHash(i+vec3(0,1,1)),disHash(i+vec3(1,1,1)),f.x),f.y),f.z); }
float disFbm(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*disNoise(p); p*=2.03; a*=0.5; }
  // FBM concentrates around its mean; stretch the contrast so the burn front
  // is a front, not a fog — most of the body sits clearly above or below it.
  return clamp((s/0.9375 - 0.5) * 1.7 + 0.5, 0.0, 1.0); }
float disField(vec3 local){
  float hN = clamp((local.y - uLocalMinY) / uLocalHeight, 0.0, 1.0);
  vec3 p = vec3(local.x, local.y - uLocalMinY, local.z) / uLocalHeight;
  float n = disFbm(p * uNoiseScale);
  return mix(n, hN, uHeightBias);
}
`;
// Runs at the top of main(): compute the field, burn what is under the
// threshold. disField/disT stay in scope for the emissive edge below
// (emissivemap_fragment runs later in the same main()).
const FRAG_CUT = /* glsl */ `
float disField = disField(vDisLocal);
float disT = mix(-0.06, 1.06, uProgress);
if (disField - disT < 0.0) discard;
#include <clipping_planes_fragment>
`;
// The burn band: fragments just ahead of the front glow. Gated at both ends
// of the ramp so a body at rest (progress 0) and a body fully gone carry no
// stray rim.
const FRAG_EDGE = /* glsl */ `
#include <emissivemap_fragment>
{ float disEdge = (1.0 - smoothstep(0.0, uEdgeWidth, disField - disT))
    * smoothstep(0.0, 0.04, uProgress) * (1.0 - smoothstep(0.95, 1.0, uProgress));
  totalEmissiveRadiance += uEdgeColor * disEdge; }
`;

interface ShaderLike {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
}

function inject(shader: ShaderLike, dissolve: Dissolve): void {
  Object.assign(shader.uniforms, dissolve.uniforms);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${VERT_HEAD}`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERT_BODY}`);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${FRAG_HEAD}`)
    .replace("#include <clipping_planes_fragment>", FRAG_CUT)
    .replace("#include <emissivemap_fragment>", FRAG_EDGE);
}

export const DISSOLVE_CACHE_KEY = "aiverse-dissolve-v1";
export const DISSOLVE_DEPTH_CACHE_KEY = "aiverse-dissolve-depth-v1";

/** Inject the dissolve into one of a body's OWN materials (never a shared GLB-cache material). */
export function applyDissolve(material: THREE.Material, dissolve: Dissolve): void {
  material.onBeforeCompile = (shader) => inject(shader as ShaderLike, dissolve);
  // Mandatory (ridelink §6): without a stable custom key three cannot tell
  // two onBeforeCompile materials apart and may hand back a wrong program.
  // The key is an addend — map/define differences still split programs.
  material.customProgramCacheKey = () => DISSOLVE_CACHE_KEY;
}

/**
 * The matching depth material, so a dissolving body's shadow burns away with
 * it instead of popping out at unmount. Same injection: the depth shader has
 * the same vertex anchors and its main() opens with clipping_planes_fragment;
 * it has no emissivemap_fragment, so the edge step simply does not apply.
 * One instance per body, shared by its meshes.
 */
export function createDissolveDepthMaterial(dissolve: Dissolve): THREE.MeshDepthMaterial {
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => inject(shader as ShaderLike, dissolve);
  depth.customProgramCacheKey = () => DISSOLVE_DEPTH_CACHE_KEY;
  return depth;
}
