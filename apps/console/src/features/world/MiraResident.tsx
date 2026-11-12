import { useGLTF } from "@react-three/drei";
import { assetUrl } from "../../lib/assetUrl";
import { extendGltf } from "./gltfExtensions";
import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { boxesMesh, type ColBox } from "./capsuleWorld";
import type { WalkColliders } from "./walkColliders";

/** Street-side paving, left of the Tea House door and outside its approach/stairs. */
const MIRA_POSITION: [number, number, number] = [-26.6, .2, -70.4];
const MIRA_COLLIDER: ColBox = [MIRA_POSITION[0], MIRA_POSITION[2], .28, .26, MIRA_POSITION[1], MIRA_POSITION[1] + 1.68, 0];

function MiraModel({ walk }: { walk?: WalkColliders }) {
  const gl = useThree((s) => s.gl);
  const gltf = useGLTF(assetUrl("/assets/residents/mira-maid.glb"), true, true, extendGltf(gl));
  const scene = useMemo(() => {
    const clone = gltf.scene.clone(true);
    clone.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return clone;
  }, [gltf.scene]);

  useEffect(() => {
    if (!walk) return;
    const collider = boxesMesh([MIRA_COLLIDER], [0, 0], "npc:mira");
    if (!collider) return;
    walk.set("npc:mira", [collider]);
    return () => { walk.drop("npc:mira"); walk.actors.remove("mira"); };
  }, [walk]);

  useFrame(() => walk?.actors.publishWalker("mira", { x: MIRA_POSITION[0], y: MIRA_POSITION[1], z: MIRA_POSITION[2], vx: 0, vz: 0 }, 0.38, 1.68, false));

  return <group name="resident:mira" position={MIRA_POSITION} dispose={null}>
    <primitive object={scene} />
  </group>;
}

/** Static user-provided resident, streamed near the Tea House. */
export function MiraResident({ walk, visitNonce = 0 }: { walk?: WalkColliders; visitNonce?: number }) {
  const { camera, controls } = useThree();
  const [near, setNear] = useState(false);
  const elapsed = useRef(0);
  const position = useMemo(() => new THREE.Vector3(...MIRA_POSITION), []);

  useEffect(() => {
    if (!visitNonce) return;
    const orbit = controls as unknown as { target: THREE.Vector3; update: () => void } | null;
    if (!orbit) return;
    orbit.target.set(position.x, position.y + .95, position.z);
    camera.position.set(position.x + 2.4, position.y + 1.85, position.z + 4.1);
    orbit.update();
  }, [visitNonce, camera, controls, position]);

  useFrame((_, dt) => {
    elapsed.current += dt;
    if (elapsed.current < .25) return;
    elapsed.current = 0;
    const distance = camera.position.distanceTo(position);
    setNear(current => distance < (current ? 55 : 45));
  });

  return near ? <Suspense fallback={null}><MiraModel walk={walk} /></Suspense> : null;
}
