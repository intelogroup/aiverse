import * as THREE from "three";

const poolBounds = new THREE.Vector4(20, 90, 50, 104);
const lidoMaterialName = "BzOpen_water";
const waves = [
  [2.7, 1.1, 0.032],
  [-1.3, 4.3, 0.017],
  [7.7, -3.6, 0.007],
  [-4.2, -10.0, 0.004],
] as const;

function waveFrequency(k: number, depth: number) {
  // Linear gravity-capillary dispersion in water, in radians per second.
  return Math.sqrt((9.81 * k + 0.000073 * k ** 3) * Math.tanh(k * depth));
}

interface Basin {
  depth: number;
  tileSize: number;
  lining: THREE.Color;
  absorption: THREE.Vector3;
  radii?: [inner: number, outer: number];
}

const lido: Basin = {
  depth: 1.25,
  tileSize: 0.29,
  lining: new THREE.Color("#a8d8d7"),
  absorption: new THREE.Vector3(0.83, 0.24, 0.11),
};

export function createFountainBasinMaterial(inner: number, outer: number, time: { value: number }) {
  return createBasinMaterial({
    depth: 0.48,
    tileSize: 0.42,
    lining: new THREE.Color("#83aaa0"),
    absorption: new THREE.Vector3(1.42, 0.68, 0.38),
    radii: [inner, outer],
  }, time);
}

const waterCommon = `
  varying vec3 vBasinWorld;
  uniform float uBasinTime;
  uniform float uBasinDepth;
  uniform float uBasinTile;
  uniform vec3 uBasinAbsorption;
  uniform vec4 uBasinRect;
  uniform vec2 uBasinRadii;
  uniform vec4 uBasinWaves[4];

  float waveAmplitude(vec2 p, vec4 wave) {
    return wave.z * (1.0 - smoothstep(0.45, 2.2, fwidth(dot(p, wave.xy))));
  }

  vec2 waterSlope(vec2 p) {
    vec2 slope = vec2(0.0);
    for (int i = 0; i < 4; ++i) {
      vec4 wave = uBasinWaves[i];
      float phase = dot(p, wave.xy) - wave.w * uBasinTime;
      slope += wave.xy * waveAmplitude(p, wave) * cos(phase);
    }
    return slope;
  }

  float focusedLight(vec2 hit, float depth) {
    // Jacobian of the near-vertical light ray's landing point. The Hessian of
    // the same wave field compresses light where the basin receives a caustic.
    vec3 curvature = vec3(0.0);
    for (int i = 0; i < 4; ++i) {
      vec4 wave = uBasinWaves[i];
      float phase = dot(hit, wave.xy) - wave.w * uBasinTime;
      curvature -= vec3(wave.x * wave.x, wave.x * wave.y, wave.y * wave.y)
        * waveAmplitude(hit, wave) * sin(phase);
    }
    vec3 j = vec3(1.0, 0.0, 1.0) + depth * (1.0 - 1.0 / 1.333) * curvature;
    float area = abs(j.x * j.z - j.y * j.y);
    return smoothstep(0.42, 1.45, 1.0 / max(0.18, area)) - 0.5;
  }

  // The refracted ray can hit the lining on either side of the basin before it reaches the floor.
  float circleHit(vec2 p, vec2 v, float r, float signOfRoot) {
    float a = max(dot(v, v), 0.00001);
    float b = dot(p, v);
    float d = b * b - a * (dot(p, p) - r * r);
    float t = (-b + signOfRoot * sqrt(max(d, 0.0))) / a;
    return d >= 0.0 && t > 0.0 ? t : 1000.0;
  }
`;

const waterSurface = `
  vec2 poolPoint = vBasinWorld.xz;
  vec2 slope = waterSlope(poolPoint);
  vec3 waterNormal = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 eyeDir = normalize(cameraPosition - vBasinWorld);
  vec3 ray = refract(-eyeDir, waterNormal, 1.0 / 1.333);
  float floorDistance = uBasinDepth / max(-ray.y, 0.1);
  float wallDistance;
  if (uBasinRadii.y > 0.0) {
    wallDistance = min(circleHit(poolPoint, ray.xz, uBasinRadii.y, 1.0),
      circleHit(poolPoint, ray.xz, uBasinRadii.x, -1.0));
  } else {
    vec2 wall = mix(uBasinRect.xy, uBasinRect.zw, step(vec2(0.0), ray.xz));
    vec2 distances = abs(wall - poolPoint) / max(abs(ray.xz), vec2(0.00001));
    wallDistance = min(distances.x, distances.y);
  }
  float opticalDistance = min(floorDistance, wallDistance);
  vec2 hit = poolPoint + ray.xz * opticalDistance;
  float hitDepth = -ray.y * opticalDistance;
  bool onWall = wallDistance < floorDistance;
  vec2 liningUV = hit;
  if (onWall) {
    if (uBasinRadii.y > 0.0) {
      liningUV = vec2(atan(hit.y, hit.x) * length(hit), hitDepth);
    } else {
      vec2 edge = min(abs(hit - uBasinRect.xy), abs(hit - uBasinRect.zw));
      liningUV = vec2(edge.x < edge.y ? hit.y : hit.x, hitDepth);
    }
  }
  vec2 tile = liningUV / uBasinTile;
  vec2 filterWidth = clamp(fwidth(tile), vec2(0.008), vec2(0.4));
  vec2 joint = abs(fract(tile + 0.5) - 0.5);
  vec2 grout = 1.0 - smoothstep(vec2(0.016), vec2(0.016) + filterWidth, joint);
  float tileDetail = 1.0 - smoothstep(0.10, 0.46, max(filterWidth.x, filterWidth.y));
  float tileShade = 1.0 - max(grout.x, grout.y) * tileDetail * 0.27;

  float caustic = focusedLight(hit, hitDepth) * tileDetail;
  vec3 transmittance = exp(-uBasinAbsorption * opticalDistance);
  float fresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(waterNormal, eyeDir), 0.0, 1.0), 5.0);
  vec3 scattered = vec3(0.013, 0.12, 0.16);
  vec3 litLining = diffuseColor.rgb * tileShade * (0.92 + 0.37 * caustic);
  diffuseColor.rgb = (litLining * transmittance + scattered * (1.0 - transmittance)) * (1.0 - fresnel);
  normal = normalize(mat3(viewMatrix) * waterNormal);
`;

function createBasinMaterial(basin: Basin, time: { value: number }) {
  const material = new THREE.MeshPhysicalMaterial({
    name: "City3BasinWater",
    color: basin.lining,
    roughness: 0.14,
    ior: 1.333,
    envMapIntensity: 1.2,
  });
  material.userData.city3BasinWater = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBasinTime = time;
    shader.uniforms.uBasinDepth = { value: basin.depth };
    shader.uniforms.uBasinTile = { value: basin.tileSize };
    shader.uniforms.uBasinAbsorption = { value: basin.absorption };
    shader.uniforms.uBasinRect = { value: poolBounds };
    shader.uniforms.uBasinWaves = { value: waves.map(([x, z, amplitude]) =>
      new THREE.Vector4(x, z, amplitude, waveFrequency(Math.hypot(x, z), basin.depth))) };
    shader.uniforms.uBasinRadii = { value: new THREE.Vector2(...(basin.radii ?? [0, 0])) };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vBasinWorld;")
      .replace("#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvBasinWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${waterCommon}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${waterSurface}`);
  };
  return material;
}

/** Reuse the authored triangles, including the far LOD. Restore the original on the cached resident. */
export function installLidoWater(root: THREE.Object3D, time: { value: number }) {
  let water: THREE.MeshPhysicalMaterial | undefined;
  const restore: (() => void)[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const original = object.material;
    const slots = Array.isArray(original) ? original : [original];
    if (!slots.some((slot) => slot.name === lidoMaterialName)) return;
    const replacement = water ??= createBasinMaterial(lido, time);
    const updated = slots.map((slot) => slot.name === lidoMaterialName ? replacement : slot);
    const castShadow = object.castShadow;
    object.material = Array.isArray(original) ? updated : updated[0];
    object.castShadow = false;
    restore.push(() => {
      object.material = original;
      object.castShadow = castShadow;
    });
  });
  return () => {
    restore.forEach((reset) => reset());
    water?.dispose();
  };
}
