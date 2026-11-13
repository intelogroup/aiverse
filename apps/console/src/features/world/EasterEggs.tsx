import { useGLTF } from "@react-three/drei";
import { assetUrl } from "../../lib/assetUrl";
import { extendGltf } from "./gltfExtensions";
import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { InteractableDef, InteractController } from "./interactables";

export type EggPlacement = {
  id: string;
  district: string;
  position: [number, number, number];
  rotationY: number;
  scale: number;
  hint: string;
};

/** Eggs are usable props: stand 0.7 m in front of the egg (along its heading), face it. Toggles like any interactable. */
export function eggInteractable(e: EggPlacement): InteractableDef {
  const [x, y, z] = e.position, h = e.rotationY;
  return {
    id: e.id, room: e.district, kind: "egg", asset: "scifi-easter-egg", label: "Easter egg",
    pos: e.position, rotY: h,
    stand: [x + Math.sin(h) * 0.7, z + Math.cos(h) * 0.7], heading: h + Math.PI, floorY: y,
  };
}

export type HaloState = "none" | "ready" | "active" | "spent";
/** What an egg's halo shows: payload taken (grey) beats activated (gold) beats usable-now (cyan pulse). */
export function haloState(s: { approached: boolean; on: boolean; spent: boolean }): HaloState {
  if (s.spent) return "spent";
  if (s.on) return "active";
  return s.approached ? "ready" : "none";
}
const HALO_COLOR: Record<Exclude<HaloState, "none">, [number, number, number]> = {
  ready: [0.2, 0.85, 1], active: [1, 0.72, 0.18], spent: [0.32, 0.32, 0.36],
};
/** Brightness multiplier at time t (s): ready breathes, active holds with a decaying flash after the flip, spent is dim and still. */
export function haloLevel(state: HaloState, t: number, sinceFlip: number): number {
  if (state === "ready") return 0.15 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 1.5));
  if (state === "active") return 0.3 + 0.9 * Math.exp(-sinceFlip * 2.5);
  if (state === "spent") return 0.08;
  return 0;
}

type Batch = { mesh: THREE.InstancedMesh; district: string; source: THREE.Matrix4 };
const MODEL = assetUrl("/assets/collectibles/scifi-easter-egg.glb");
const NEAR_METRES = 85;

/** Shared geometry/materials, instanced by district. These are future hunt props, not collectible prizes yet. */
function EggInstances({ placements, activeDistricts }: { placements: EggPlacement[]; activeDistricts: string[] }) {
  const gl = useThree((s) => s.gl);
  const gltf = useGLTF(MODEL, true, true, extendGltf(gl));
  const { scene, camera } = useThree();
  const batches = useRef<Batch[]>([]);
  const elapsed = useRef(Infinity);
  const active = useRef(activeDistricts);
  active.current = activeDistricts;

  useEffect(() => {
    // Allocate in the effect: StrictMode cleanup must never dispose a reused instance buffer.
    const root = new THREE.Group();
    root.name = "hunt:easter-eggs";
    root.userData.contestActive = false;
    root.userData.placementCount = placements.length;
    gltf.scene.updateMatrixWorld(true);
    const next: Batch[] = [];
    for (const district of new Set(placements.map(p => p.district))) {
      const capacity = placements.filter(p => p.district === district).length;
      gltf.scene.traverse(object => {
        const source = object as THREE.Mesh;
        if (!source.isMesh) return;
        const mesh = new THREE.InstancedMesh(source.geometry, source.material, capacity);
        mesh.name = `easter-eggs:${district}:${next.length}`;
        mesh.count = 0;
        mesh.visible = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.userData.eggIds = [];
        root.add(mesh);
        next.push({ mesh, district, source: source.matrixWorld.clone() });
      });
    }
    batches.current = next;
    elapsed.current = Infinity;
    scene.add(root);
    return () => {
      scene.remove(root);
      batches.current = [];
      // Geometry/materials belong to useGLTF's shared cache. Dispose only owned instance buffers.
      next.forEach(({ mesh }) => mesh.dispose());
    };
  }, [gltf.scene, placements, scene]);

  const matrix = useRef(new THREE.Matrix4());
  const position = useRef(new THREE.Vector3());
  const scale = useRef(new THREE.Vector3());
  const rotation = useRef(new THREE.Quaternion());
  const up = useRef(new THREE.Vector3(0, 1, 0));
  useFrame((_, delta) => {
    elapsed.current += delta;
    if (elapsed.current < .25) return;
    elapsed.current = 0;
    for (const batch of batches.current) {
      const ids: string[] = [];
      if (active.current.includes(batch.district)) {
        for (const egg of placements) {
          if (egg.district !== batch.district || Math.hypot(camera.position.x - egg.position[0], camera.position.z - egg.position[2]) > NEAR_METRES) continue;
          position.current.set(...egg.position);
          scale.current.setScalar(egg.scale);
          rotation.current.setFromAxisAngle(up.current, egg.rotationY);
          matrix.current.compose(position.current, rotation.current, scale.current).multiply(batch.source);
          batch.mesh.setMatrixAt(ids.length, matrix.current);
          ids.push(egg.id);
        }
      }
      batch.mesh.count = ids.length;
      batch.mesh.visible = ids.length > 0;
      // Instance indices can change as the camera travels; IDs remain stable for a later hunt controller.
      batch.mesh.userData.eggIds = ids;
      batch.mesh.instanceMatrix.needsUpdate = true;
      if (ids.length) batch.mesh.computeBoundingSphere();
    }
  });
  return null;
}

/** One additive glow shell per nearby egg, tinted by haloState. Cheap: a single shared InstancedMesh, no shader edits. */
function EggHalos({ placements, interact }: { placements: EggPlacement[]; interact: InteractController }) {
  const { scene, camera } = useThree();
  const mesh = useRef<THREE.InstancedMesh | null>(null);
  const flips = useRef(new Map<string, number>());
  const clock = useRef(0);
  useEffect(() => {
    const m = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      placements.length,
    );
    m.name = "easter-eggs:halos";
    m.count = 0;
    m.frustumCulled = false;
    m.renderOrder = 5;
    m.raycast = () => {}; // never block picking or camera collision
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(placements.length * 3), 3);
    scene.add(m);
    mesh.current = m;
    const off = interact.subscribe((id, on) => { if (on) flips.current.set(id, clock.current); });
    return () => { off(); scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); mesh.current = null; };
  }, [placements, interact, scene]);
  const m4 = useRef(new THREE.Matrix4());
  const col = useRef(new THREE.Color());
  useFrame((_, delta) => {
    clock.current += delta;
    const m = mesh.current;
    if (!m) return;
    let n = 0;
    for (const egg of placements) {
      if (Math.hypot(camera.position.x - egg.position[0], camera.position.z - egg.position[2]) > NEAR_METRES) continue;
      const state = haloState({ approached: interact.isApproached(egg.id), on: interact.isOn(egg.id), spent: interact.isSpent(egg.id) });
      if (state === "none") continue;
      const k = haloLevel(state, clock.current, clock.current - (flips.current.get(egg.id) ?? -99));
      const [r, g, b] = HALO_COLOR[state];
      const radius = 0.42 * egg.scale;
      m4.current.makeScale(radius, radius * 1.25, radius).setPosition(egg.position[0], egg.position[1] + 0.25 * egg.scale, egg.position[2]);
      m.setMatrixAt(n, m4.current);
      m.setColorAt(n, col.current.setRGB(r * k, g * k, b * k));
      n++;
    }
    m.count = n;
    m.visible = n > 0;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return null;
}

export function EasterEggs({ activeDistricts, interact }: { activeDistricts: string[]; interact?: InteractController }) {
  const [placements, setPlacements] = useState<EggPlacement[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/assets/collectibles/easter-eggs.json", { signal: abort.signal })
      .then(response => { if (!response.ok) throw new Error("Egg placements unavailable"); return response.json(); })
      .then(manifest => setPlacements(manifest.eggs))
      .catch(error => { if (error.name !== "AbortError") console.warn("Easter egg placements", error); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!interact || !placements.length) return;
    interact.register(placements.map(eggInteractable), "eggs");
    return () => interact.register([], "eggs");
  }, [interact, placements]);
  return placements.length ? (
    <Suspense fallback={null}>
      <EggInstances placements={placements} activeDistricts={activeDistricts} />
      {interact ? <EggHalos placements={placements} interact={interact} /> : null}
    </Suspense>
  ) : null;
}
