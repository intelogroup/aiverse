import { useGLTF } from "@react-three/drei";
import { extendGltf } from "./gltfExtensions";
import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useRef, useState } from "react";
import * as THREE from "three";

export type EggPlacement = {
  id: string;
  district: string;
  position: [number, number, number];
  rotationY: number;
  scale: number;
  hint: string;
};

type Batch = { mesh: THREE.InstancedMesh; district: string; source: THREE.Matrix4 };
const MODEL = "/assets/collectibles/scifi-easter-egg.glb";
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

export function EasterEggs({ activeDistricts }: { activeDistricts: string[] }) {
  const [placements, setPlacements] = useState<EggPlacement[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/assets/collectibles/easter-eggs.json", { signal: abort.signal })
      .then(response => { if (!response.ok) throw new Error("Egg placements unavailable"); return response.json(); })
      .then(manifest => setPlacements(manifest.eggs))
      .catch(error => { if (error.name !== "AbortError") console.warn("Easter egg placements", error); });
    return () => abort.abort();
  }, []);
  return placements.length ? <Suspense fallback={null}><EggInstances placements={placements} activeDistricts={activeDistricts} /></Suspense> : null;
}
