import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { useGLTF } from "@react-three/drei";
import { CameraCollider, buildColliders, type ColliderStats } from "./CameraCollider";
import { bakeCollisionParts } from "./capsuleWorld";
import { FountainWater } from "./FountainWater";
import { EasterEggs } from "./EasterEggs";
import type { WalkColliders } from "./walkColliders";
import { blendTheme, collisionJobs, dueEvictions, isShellCovered, planDistricts, residentCollisionUrl, type DistrictDef, type DistrictManifest, type Theme } from "./districts";

export const DISTRICTS_URL = "/assets/districts.json";

const disposeTree = (root: THREE.Object3D) =>
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.geometry.boundsTree) m.geometry.disposeBoundsTree();
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
 * (planDistricts, tightened 2026-11-08: load <=90 m, keep <=300 m, cap 3, 20 s eviction grace, velocity
 * lookahead prefetch) and are fully disposed on eviction. The manifest's far shell (box massing per district)
 * is always resident and hides per district as the real geometry lands, so no viewpoint ever sees a hole;
 * a failed load retries once, then warns and leaves the shell up. `?world=full` restores the old behaviour
 * (every district loads at spawn, nothing evicts) for debugging. Per frame the focus blends the district
 * themes into the sky dome, fog, key light, water, exposure, environment intensity and emissive "night"
 * amount. The environment map itself is GlbWorld StageEnvironment's RoomEnvironment (shared with the other
 * places). `window.__districts` exposes counters + the load/unload event log for the memory test
 * (?districtDebug=1).
 */
export function DistrictWorld({ residentUrl, light, collide = true, meshesRef, walk, streamCap }: { residentUrl: string; light: React.RefObject<THREE.DirectionalLight | null>; collide?: boolean; meshesRef?: { current: (() => THREE.Mesh[]) | null }; walk?: WalkColliders; streamCap?: number }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null;
  const [manifest, setManifest] = useState<DistrictManifest | null>(null);
  const [, bump] = useState(0);
  const resident = useGLTF(residentUrl);
  const groups = useRef(new Map<string, THREE.Group>());
  const loading = useRef(new Set<string>());
  const stats = useRef({ loads: 0, evictions: 0, failures: 0, retries: 0, loadMs: [] as number[], events: [] as { t: number; type: string; id?: string }[], bvhMs: {} as Record<string, number>, colliderHits: 0, colliderFrames: 0, colliderMs: 0, colliderMeshes: 0 } satisfies ColliderStats & Record<string, unknown>);
  // Streaming bookkeeping: eviction-grace stamps, focus velocity (lookahead), the set the latest
  // plan wants loaded (retry guard), per-cycle retry spend, and the far shell's per-district groups.
  const evictSince = useRef(new Map<string, number>());
  const prevFocus = useRef<{ x: number; z: number; t: number } | null>(null);
  const wantedRef = useRef(new Set<string>());
  const retriedRef = useRef(new Set<string>());
  const aliveRef = useRef(true);
  const shellGroups = useRef(new Map<string, THREE.Object3D>());
  // The resident (manifest `resident` flag) never enters the streamed `groups` set — it loads via
  // useGLTF — so shell coverage needs its id + a mounted flag beside the streamed set (isShellCovered).
  const residentIdRef = useRef<string | undefined>(undefined);
  const residentReadyRef = useRef(false);
  const fullMode = useMemo(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("world") === "full", []);
  const pushEvent = (type: string, id?: string) => {
    const ev = stats.current.events;
    ev.push({ t: Math.round(performance.now()) / 1000, type, id });
    if (ev.length > 200) ev.splice(0, ev.length - 200);
  };
  const syncShell = () => {
    const loaded = new Set(groups.current.keys());
    for (const [id, g] of shellGroups.current) g.visible = !isShellCovered(id, loaded, residentIdRef.current, residentReadyRef.current);
  };
  // Camera-collision meshes per root (resident, links, each streamed district); flattened lazily for the collider.
  const colliderSets = useRef(new Map<string, THREE.Mesh[]>());
  const colliderFlat = useRef<THREE.Mesh[] | null>(null);
  const addColliders = (key: string, root: THREE.Object3D) => {
    const { meshes, ms } = buildColliders(root);
    colliderSets.current.set(key, meshes); colliderFlat.current = null; if (meshes.length) stats.current.bvhMs[key] = Math.max(stats.current.bvhMs[key] ?? 0, Math.round(ms));
    stats.current.colliderMeshes = [...colliderSets.current.values()].reduce((n, x) => n + x.length, 0);
  };
  const dropColliders = (key: string) => { colliderSets.current.delete(key); colliderFlat.current = null; };
  const collideDebug = useRef(true);
  const getMeshes = () => (colliderFlat.current ??= [...colliderSets.current.values()].flat());
  // The walker (CityWalker) raycasts the same meshes; it reads them through this ref.
  if (meshesRef) meshesRef.current = getMeshes;
  const themeRef = useRef<Theme | null>(null);
  const clock = useRef(0);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    let live = true;
    fetch(DISTRICTS_URL).then((r) => r.json()).then((m: DistrictManifest) => live && setManifest(m)).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    residentIdRef.current = manifest?.districts.find((d) => d.resident)?.id;
    syncShell();
  }, [manifest]);

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
    // Legacy GLBs combine sea, basin and nozzle caps in the Water mesh. Hide
    // that legacy surface and the newer separate Sea; the ocean below and
    // FountainWater render independently. Restore cached GLB visibility on exit.
    const hiddenWater: { mesh: THREE.Mesh; visible: boolean }[] = [];
    resident.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (mats.some(mat => mat.name === "water" || mat.name === "sea")) {
        hiddenWater.push({ mesh: m, visible: m.visible }); m.visible = false;
      }
    });
    gl.toneMapping = THREE.AgXToneMapping;
    // useGLTF caches the resident, so its BVHs are built once and kept with it (buildColliders is idempotent).
    addColliders("resident", resident.scene);
    // The resident is mounted: its far-shell group is covered from here on (isShellCovered).
    residentReadyRef.current = true;
    syncShell();
    return () => {
      residentReadyRef.current = false;
      hiddenWater.forEach(({ mesh, visible }) => { mesh.visible = visible; });
      dropColliders("resident");
      // StageEnvironment owns the reflection map; clearing it here loses glass/metal reflections on remount.
      scene.remove(sky); scene.remove(water); scene.remove(hemi); scene.fog = null; scene.background = null;
      for (const [id, g] of groups.current) { scene.remove(g); dropColliders(id); walk?.drop(id); disposeTree(g); }
      groups.current.clear(); (sky.material as THREE.Material).dispose(); sky.geometry.dispose(); (water.material as THREE.Material).dispose(); water.geometry.dispose();
    };
  }, [scene, sky, water, hemi, gl, resident]);

  useEffect(() => {
    if (!manifest?.links) return;
    let live = true; let root: THREE.Object3D | null = null;
    loader.load(manifest.links, (g) => { if (!live) { disposeTree(g.scene); return; } root = g.scene; scene.add(root); applyNight(root, themeRef.current?.night ?? 0); addColliders("links", root); });
    return () => { live = false; if (root) { scene.remove(root); dropColliders("links"); disposeTree(root); } };
  }, [manifest, loader, scene]);

  // Far shell: one small box-massing GLB for the whole city, always resident. Each `shell_<id>`
  // group hides once the district is covered (syncShell -> isShellCovered): streamed districts when
  // their detail lands in `groups`, the resident once it has mounted. So a district is never a hole —
  // it is either detail or massing. A shell failure only warns (detail still works).
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  useEffect(() => {
    if (!manifest?.shell) return;
    let live = true; let root: THREE.Object3D | null = null;
    loader.load(manifest.shell, (g) => {
      if (!live) { disposeTree(g.scene); return; }
      root = g.scene; scene.add(root);
      // Node names arrive sanitized: GLTFLoader strips `:` (PropertyBinding.sanitizeNodeName), so the
      // generator names these `shell_<id>` — a `shell:` prefix match would silently never fire and no
      // shell group would ever hide (found by probe, 2026-11-09). Accept the legacy colon form too.
      root.traverse((o) => { const m = /^shell[_:](.+)$/.exec(o.name); if (m) shellGroups.current.set(m[1], o); });
      syncShell(); pushEvent("shell-ok");
    }, undefined, () => { if (live) { console.warn("[districts] far shell failed to load; unloaded districts will show water until their detail streams in"); pushEvent("shell-fail"); } });
    return () => { live = false; shellGroups.current.clear(); if (root) { scene.remove(root); disposeTree(root); } };
  }, [manifest, loader, scene]);

  const defs = manifest?.districts ?? [];

  // Walker collision (separate from the camera's colliderSets): never added to the scene, baked into one BVH mesh per GLB.
  const loadCollision = (key: string, url: string, center: [number, number] | null, isLive: () => boolean, onDone?: (ok: boolean) => void) => {
    if (!walk) return;
    const t0 = performance.now();
    loader.load(url, (gltf) => {
      if (!isLive()) { disposeTree(gltf.scene); onDone?.(false); return; }
      const g = new THREE.Group(); if (center) g.position.set(center[0], 0, center[1]); g.add(gltf.scene); g.updateMatrixWorld(true);
      const meshes = bakeCollisionParts(g, `collision:${key}`, m => !(walk.elevator?.ready && m.userData.elevatorDoor));
      disposeTree(gltf.scene);
      if (meshes.length) walk.set(key, meshes, performance.now() - t0);
      onDone?.(meshes.length > 0);
    }, undefined, () => onDone?.(false));
  };
  useEffect(() => {
    if (!walk || !manifest) return;
    let live = true; walk.status = "loading";
    loadCollision("resident", residentCollisionUrl(manifest.districts), null, () => live, (ok) => { if (live) walk.status = ok ? "ready" : "failed"; });
    return () => { live = false; walk.drop("resident"); };
  }, [manifest, walk, loader]);
  const w = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : null;
  useEffect(() => {
    if (!w || !new URLSearchParams(window.location.search).has("districtDebug")) return;
    w.__districts = {
      stats: () => ({ loaded: [...groups.current.keys()], mode: fullMode ? "full" : "streamed", ...stats.current, collision: walk?.stats() ?? null, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, calls: gl.info.render.calls, triangles: gl.info.render.triangles, shell: Object.fromEntries([...shellGroups.current].map(([id, g]) => [id, g.visible])) }),
      events: () => stats.current.events,
      theme: () => themeRef.current,
      // Debug: first collider hit distance along o->dir (null = none), and switch the camera collider off/on.
      probe: (o: number[], d: number[], far = 500) => {
        const rc = Object.assign(new THREE.Raycaster(new THREE.Vector3(o[0], o[1], o[2]), new THREE.Vector3(d[0], d[1], d[2]).normalize(), 0, far), { firstHitOnly: true });
        return rc.intersectObjects(getMeshes(), false)[0]?.distance ?? null;
      },
      collide: (on: boolean) => { collideDebug.current = on; bump((n) => n + 1); },
      focus: (x: number, z: number) => { if (controls) { controls.target.set(x, 8, z); } },
      cam: (p: number[], t: number[]) => { camera.position.set(p[0], p[1], p[2]); controls?.target.set(t[0], t[1], t[2]); camera.lookAt(t[0], t[1], t[2]); (controls as unknown as { update?: () => void })?.update?.(); },
    };
    return () => { delete w.__districts; };
  }, [w, gl, controls, camera]);

  const load = (d: DistrictDef, isRetry = false) => {
    if (loading.current.has(d.id) || groups.current.has(d.id)) return;
    loading.current.add(d.id); const t0 = performance.now();
    pushEvent(isRetry ? "retry" : "load-start", d.id);
    loader.load(d.url, (gltf) => {
      loading.current.delete(d.id);
      const g = new THREE.Group(); g.name = `district:${d.id}`; g.position.set(d.center[0], 0, d.center[1]); g.add(gltf.scene);
      applyNight(g, themeRef.current?.night ?? 0);
      g.updateMatrixWorld(true); addColliders(d.id, g);
      for (const [key, url] of collisionJobs([d.id], defs)) loadCollision(key, url, d.center, () => groups.current.has(d.id));
      groups.current.set(d.id, g); scene.add(g); stats.current.loads++; stats.current.loadMs.push(Math.round(performance.now() - t0)); pushEvent("load-ok", d.id); syncShell(); bump((n) => n + 1);
    }, undefined, () => {
      loading.current.delete(d.id);
      stats.current.failures++; pushEvent("load-fail", d.id);
      // One retry per want-cycle, and only while the plan still wants the district;
      // after that the far shell keeps covering the district and we warn once here.
      if (!isRetry && !retriedRef.current.has(d.id)) {
        retriedRef.current.add(d.id); stats.current.retries++;
        setTimeout(() => { if (aliveRef.current && wantedRef.current.has(d.id)) load(d, true); }, 3000);
      } else {
        console.warn(`[districts] ${d.id} failed to load after a retry; its far shell stays visible`);
      }
    });
  };
  const unload = (id: string) => {
    const g = groups.current.get(id); if (!g) return;
    scene.remove(g); dropColliders(id); walk?.drop(id); disposeTree(g); groups.current.delete(id); stats.current.evictions++; evictSince.current.delete(id); pushEvent("unload", id); syncShell(); bump((n) => n + 1);
  };

  useFrame((_, dt) => {
    sky.position.copy(camera.position);
    if (!manifest || !controls) return;
    clock.current += dt; if (clock.current < 0.25) return; clock.current = 0;
    const focus: [number, number] = [controls.target.x, controls.target.z];
    // Velocity lookahead: prefetch toward where the focus is heading (6 s ahead, clamped to
    // 240 m); it only ever adds loads — planDistricts judges keeps from the true focus alone.
    const nowMs = performance.now();
    let ahead: [number, number] | undefined;
    const pf = prevFocus.current;
    if (pf && nowMs > pf.t) {
      const dt = (nowMs - pf.t) / 1000;
      let ax = focus[0] + ((focus[0] - pf.x) / dt) * 6;
      let az = focus[1] + ((focus[1] - pf.z) / dt) * 6;
      const ox = ax - focus[0], oz = az - focus[1];
      const len = Math.hypot(ox, oz);
      if (len > 240) { ax = focus[0] + (ox / len) * 240; az = focus[1] + (oz / len) * 240; }
      if (len > 4) ahead = [ax, az];
    }
    prevFocus.current = { x: focus[0], z: focus[1], t: nowMs };
    const loadedSet = new Set(groups.current.keys());
    const plan = fullMode
      ? { load: defs.filter((d) => !d.resident && !loadedSet.has(d.id) && !loading.current.has(d.id)).map((d) => d.id), unload: [] as string[] }
      : planDistricts(focus, defs, loadedSet, { ahead, cap: streamCap });
    wantedRef.current = new Set([...loadedSet].filter((id) => !plan.unload.includes(id)).concat(plan.load));
    for (const id of [...retriedRef.current]) if (!wantedRef.current.has(id)) retriedRef.current.delete(id);
    // Eviction grace: stamp when a district first falls out of the keep radius; evict only the due.
    for (const id of plan.unload) if (!evictSince.current.has(id)) evictSince.current.set(id, nowMs);
    for (const id of [...evictSince.current.keys()]) if (!plan.unload.includes(id)) evictSince.current.delete(id);
    dueEvictions(plan.unload, evictSince.current, nowMs).forEach(unload);
    plan.load.forEach((id) => { const d = defs.find((x) => x.id === id); if (d) load(d); });
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
  return (
    <>
      <primitive object={resident.scene} />
      <FountainWater />
      <EasterEggs activeDistricts={["bazaar", ...groups.current.keys()]} />
      <CameraCollider getMeshes={getMeshes} enabled={collide && collideDebug.current} stats={stats.current} />
    </>
  );
}
