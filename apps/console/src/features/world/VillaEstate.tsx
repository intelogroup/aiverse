import { useGLTF } from "@react-three/drei";
import { assetUrl } from "../../lib/assetUrl";
import { extendGltf } from "./gltfExtensions";
import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { cloneVillaScene } from "./villaMaterials";

/**
 * The Villa — a user-supplied estate (source: a 3DS model uploaded by the
 * owner 2026-11-23; converted to GLB at full fidelity — 1,265,477 tris,
 * no decimation, per the owner's instruction; see tools/city3/ASSETS.md).
 *
 * Why it stands outside the bazaar grid: at true scale the walled plot is
 * 111 x 54 m, and the bazaar's street grid (streets at x/z = -130, -65, 0,
 * 65, 130) leaves no street-free run longer than ~55 m anywhere inside it —
 * every in-grid placement would cover a street or demolish buildings. So
 * the estate stands on its own slab beyond the south rim, centred on the
 * city's axis, forecourt facing the city. Since the dam pass
 * (tools/city3/bridge_villa_dam.py) it is a visitable place: the south
 * link bridge's deck and the forecourt are in the resident collision set
 * and the baked navmesh, and city3-places.json carries it as the
 * "villa" landmark — an agent can walk the avenue, cross the dam and
 * arrive at the forecourt. The house itself stays one collision solid:
 * there is no interior to enter.
 *
 * Placement data: the source GLB's numeric space is centimetres, so the
 * group carries the x0.01 normalisation; geometry itself is untouched.
 * Local ground datum is the plot slab's top face (local y = 0; parts of
 * the model hang to -3.18 m below it, inside the slab), so the group sits
 * at the city ground height y = 0.2 with the slab top flush.
 */
const VILLA_POSITION: [number, number, number] = [0, 0.2, 252];
const VILLA_ROTATION_Y = Math.PI; // forecourt (local +Z) faces the city
const VILLA_SCALE = 0.01; // source GLB is in centimetre numerics
const LOAD_WITHIN = 430; // landmark: visible from across the map
const UNLOAD_BEYOND = 500;

function VillaModel() {
  const gl = useThree((s) => s.gl);
  const bridge = useGLTF(assetUrl("/assets/villa-bridge.glb"), true, true, extendGltf(gl));
  const gltf = useGLTF(assetUrl("/assets/villa.glb"), true, true, extendGltf(gl));
  const scene = useMemo(() => cloneVillaScene(gltf.scene), [gltf.scene]);

  return (
    <>
    <primitive object={bridge.scene} dispose={null} />
    <group name="landmark:villa" position={VILLA_POSITION} rotation={[0, VILLA_ROTATION_Y, 0]} scale={VILLA_SCALE} dispose={null}>
      <primitive object={scene} />
    </group>
    </>
  );
}

/** Static user-provided estate, streamed by camera distance like Mira. */
export function VillaEstate() {
  const { camera } = useThree();
  const [near, setNear] = useState(false);
  const elapsed = useRef(0);
  const position = useMemo(() => new THREE.Vector3(...VILLA_POSITION), []);

  useFrame((_, dt) => {
    elapsed.current += dt;
    if (elapsed.current < .25) return;
    elapsed.current = 0;
    const distance = camera.position.distanceTo(position);
    setNear(current => distance < (current ? UNLOAD_BEYOND : LOAD_WITHIN));
  });

  return near ? <Suspense fallback={null}><VillaModel /></Suspense> : null;
}
