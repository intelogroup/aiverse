import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { useGLTF } from "@react-three/drei";
import { blendTheme, planDistricts, type DistrictDef, type DistrictManifest, type Theme } from "./districts";

export const DISTRICTS_URL = "/assets/districts.json";

const disposeTree = (root: THREE.Object3D) =>
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const v of Object.values(mat as unknown as Record<string, unknown>)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
      mat.dispose();
    }
  });

const EMISSIVE: Record<string, number> = { glass: 1.5, msign: 0.9, led: 1.0 };
/** Scale emissive windows/signs/LEDs by the theme's `night`; the base intensity is remembered on the material. */
function applyNight(root: THREE.Object3D, night: number) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const std = mat as THREE.MeshStandardMaterial;
      const k = EMISSIVE[std.name];
      if (k === undefined || !std.emissive) continue;
      std.userData.baseEmissive ??= std.emissiveIntensity || 1;
      std.emissiveIntensity = std.userData.baseEmissive * (std.name === "led" ? 0.15 + night * k : night * k);
    }
  });
}

const SKY_VERT = `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`;
const SKY_FRAG = `varying vec3 vDir; uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunCol;
void main(){ float h = clamp(vDir.y, -0.2, 1.0); vec3 c = mix(horizon, top, pow(max(h,0.0), 0.55));
  c = mix(c, horizon * 0.8, smoothstep(0.0, -0.2, vDir.y));
  float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0); c += sunCol * (pow(s, 600.0) * 4.0 + pow(s, 8.0) * 0.28);
  gl_FragColor = vec4(c, 1.0); }`;

/**
 * The district world: the Bazaar stays resident (useGLTF); other islands stream by the orbit target's distance
 * (planDistricts) and are fully disposed on eviction. Per frame the focus blends the district themes into the sky dome,
 * fog, key light, water, exposure, environment intensity and emissive "night" amount. The environment map itself is
 * GlbWorld StageEnvironment's RoomEnvironment (shared with the other places).
 * `window.__districts` exposes counters for the memory test (?districtDebug=1).
 */
export function DistrictWorld({ residentUrl, light }: { residentUrl: string; light: React.RefObject<THREE.DirectionalLight | null> }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null;
  const [manifest, setManifest] = useState<DistrictManifest | null>(null);
  const [, bump] = useState(0);
  const resident = useGLTF(residentUrl);
  const groups = useRef(new Map<string, THREE.Group>());
  const loading = useRef(new Set<string>());
  const stats = useRef({ loads: 0, evictions: 0, loadMs: [] as number[] });
  const themeRef = useRef<Theme | null>(null);
  const clock = useRef(0);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    let live = true;
    fetch(DISTRICTS_URL).then((r) => r.json()).then((m: DistrictManifest) => live && setManifest(m)).catch(() => {});
    return () => { live = false; };
  }, []);

  const loader = useMemo(() => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder), []);
  const sky = useMemo(() => {
    const mat = new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() } } });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat); mesh.frustumCulled = false; mesh.renderOrder = -1000; mesh.scale.setScalar(2500);
    return mesh;
  }, []);
  const water = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshStandardMaterial({ color: "#1c6a84", roughness: 0.12, metalness: 0.0 }));
    m.rotation.x = -Math.PI / 2; m.position.y = -1.25; m.receiveShadow = true; return m;
  }, []);
  // Warm hemisphere fill (deeper-grade tune): with envIntensity lowered the
  // RoomEnvironment wash no longer flattens the palette, and this fill —
  // sky warm, ground earth — keeps shade readable without desaturating it.
  // Intensity comes from the theme's ambient field in the frame loop.
  const hemi = useMemo(() => {
    const h = new THREE.HemisphereLight();
    h.color.setRGB(1.0, 0.85, 0.62); h.groundColor.setRGB(0.45, 0.36, 0.22); h.intensity = 0;
    return h;
  }, []);
  useEffect(() => {
    scene.add(sky); scene.add(water); scene.add(hemi);
    scene.fog = new THREE.FogExp2(0xb0b8c8, 0.0006);
    resident.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && (m.material as THREE.Material).name === "water") m.visible = false; });
    gl.toneMapping = THREE.AgXToneMapping;
    return () => {
      scene.remove(sky); scene.remove(water); scene.remove(hemi); scene.fog = null; scene.background = null; scene.environment = null;
      for (const g of groups.current.values()) { scene.remove(g); disposeTree(g); }
      groups.current.clear(); (sky.material as THREE.Material).dispose(); sky.geometry.dispose(); (water.material as THREE.Material).dispose(); water.geometry.dispose();
    };
  }, [scene, sky, water, hemi, gl, resident]);

  useEffect(() => {
    if (!manifest?.links) return;
    let live = true; let root: THREE.Object3D | null = null;
    loader.load(manifest.links, (g) => { if (!live) { disposeTree(g.scene); return; } root = g.scene; scene.add(root); applyNight(root, themeRef.current?.night ?? 0); });
    return () => { live = false; if (root) { scene.remove(root); disposeTree(root); } };
  }, [manifest, loader, scene]);

  const defs = manifest?.districts ?? [];
  const w = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : null;
  useEffect(() => {
    if (!w || !new URLSearchParams(window.location.search).has("districtDebug")) return;
    w.__districts = {
      stats: () => ({ loaded: [...groups.current.keys()], ...stats.current, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, calls: gl.info.render.calls, triangles: gl.info.render.triangles }),
      theme: () => themeRef.current,
      focus: (x: number, z: number) => { if (controls) { controls.target.set(x, 8, z); } },
      cam: (p: number[], t: number[]) => { camera.position.set(p[0], p[1], p[2]); controls?.target.set(t[0], t[1], t[2]); camera.lookAt(t[0], t[1], t[2]); (controls as unknown as { update?: () => void })?.update?.(); },
    };
    return () => { delete w.__districts; };
  }, [w, gl, controls, camera]);

  const load = (d: DistrictDef) => {
    if (loading.current.has(d.id) || groups.current.has(d.id)) return;
    loading.current.add(d.id); const t0 = performance.now();
    loader.load(d.url, (gltf) => {
      loading.current.delete(d.id);
      const g = new THREE.Group(); g.name = `district:${d.id}`; g.position.set(d.center[0], 0, d.center[1]); g.add(gltf.scene);
      applyNight(g, themeRef.current?.night ?? 0);
      groups.current.set(d.id, g); scene.add(g); stats.current.loads++; stats.current.loadMs.push(Math.round(performance.now() - t0)); bump((n) => n + 1);
    }, undefined, () => loading.current.delete(d.id));
  };
  const unload = (id: string) => {
    const g = groups.current.get(id); if (!g) return;
    scene.remove(g); disposeTree(g); groups.current.delete(id); stats.current.evictions++; bump((n) => n + 1);
  };

  useFrame((_, dt) => {
    sky.position.copy(camera.position);
    if (!manifest || !controls) return;
    clock.current += dt; if (clock.current < 0.25) return; clock.current = 0;
    const focus: [number, number] = [controls.target.x, controls.target.z];
    const plan = planDistricts(focus, defs, new Set(groups.current.keys()));
    plan.unload.forEach(unload); plan.load.forEach((id) => { const d = defs.find((x) => x.id === id); if (d) load(d); });
    // theme
    const t = blendTheme(focus, manifest); const prev = themeRef.current; themeRef.current = t;
    const u = (sky.material as THREE.ShaderMaterial).uniforms;
    u.top.value.setRGB(...t.skyTop); u.horizon.value.setRGB(...t.skyHorizon); u.sunDir.value.set(...t.sunDir).normalize(); u.sunCol.value.setRGB(...t.sun);
    (scene.fog as THREE.FogExp2).color.setRGB(...t.fog); (scene.fog as THREE.FogExp2).density = t.fogDensity;
    (water.material as THREE.MeshStandardMaterial).color.setRGB(...t.water);
    gl.toneMappingExposure = t.exposure; scene.environmentIntensity = t.envIntensity;
    hemi.intensity = t.ambient * 5;
    const l = light.current;
    if (l) {
      const sd = new THREE.Vector3(...t.sunDir).normalize(); const tx = Math.round(controls.target.x / 40) * 40; const tz = Math.round(controls.target.z / 40) * 40;
      l.target.position.set(tx, 0, tz); l.target.updateMatrixWorld(); l.position.set(tx + sd.x * 400, sd.y * 400, tz + sd.z * 400);
      l.color.setRGB(...t.sun); l.intensity = t.sunIntensity;
    }
    if (!prev || Math.abs(prev.night - t.night) > 0.02) { applyNight(resident.scene, t.night); groups.current.forEach((g) => applyNight(g, t.night)); }
    // scene.environment itself is owned by GlbWorld's StageEnvironment
    // (RoomEnvironment, same as the other places) — a sky-gradient-only
    // PMREM here left the foliage with no real fill and read pale under
    // AgX. This loop still drives environmentIntensity from the theme.
  });
  return <primitive object={resident.scene} />;
}
