import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { JUNCTIONS, flashOn, signalState } from "@aiverse/world-sim/trafficSignals";
import { assetUrl } from "../../lib/assetUrl";
import { extendGltf } from "./gltfExtensions";
import manifest from "./signalLamps.json";

// tools/city3/signals.py: the GLB holds the posts and heads (static); the lamps are rows in signalLamps.json, drawn here as
// one instanced mesh so each junction can run its own phase.  Lamp state is a pure function of the wall clock
// (packages/world-sim/src/trafficSignals.ts), so it keeps running and matches every other viewer and the sim.
const MODEL = assetUrl("/assets/world-signals.glb");
const OFF = 0.1;   // unlit lamp brightness relative to lit
const COLOURS: Record<string, THREE.Color> = {
  red: new THREE.Color(1.0, 0.1, 0.08), yellow: new THREE.Color(1.0, 0.72, 0.05), green: new THREE.Color(0.1, 1.0, 0.35),
  walk: new THREE.Color(0.9, 0.95, 1.0), dont: new THREE.Color(1.0, 0.42, 0.04),
};

/** Traffic signals at the Bazaar junctions running a coordinated pretimed plan with pedestrian heads. */
export function IntersectionSignals() {
  const gl = useThree((s) => s.gl);
  const gltf = useGLTF(MODEL, true, true, extendGltf(gl));
  const mesh = useRef<THREE.InstancedMesh>(null);
  const shown = useRef<string[]>([]);
  const rows = useMemo(() => {
    const byJunction = new Map<number, number[]>();
    manifest.lamps.forEach((l, i) => { const a = byJunction.get(l.j) ?? []; a.push(i); byJunction.set(l.j, a); });
    return byJunction;
  }, []);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
    manifest.lamps.forEach((l, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.yaw);
      mat.compose(pos.set(l.p[0]!, l.p[1]!, l.p[2]!), q, sc.set(l.s[0]!, l.s[1]!, 1));
      m.setMatrixAt(i, mat);
      m.setColorAt(i, COLOURS[l.kind]!.clone().multiplyScalar(OFF));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    shown.current = [];
  }, []);

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const now = Date.now() / 1000;
    const flash = flashOn(now);
    const c = new THREE.Color();
    for (const j of JUNCTIONS) {
      const s = signalState(j, now);
      const key = `${s.ns}${s.ew}${s.pedNs}${s.pedEw}${s.pedNs === "flash" || s.pedEw === "flash" ? flash : ""}`;
      if (shown.current[j.id] === key) continue;
      shown.current[j.id] = key;
      for (const i of rows.get(j.id) ?? []) {
        const l = manifest.lamps[i]!;
        const lamp = l.phase === "ns" ? s.ns : s.ew, pedState = l.phase === "ns" ? s.pedNs : s.pedEw;
        const on = l.kind === "walk" ? pedState === "walk"
          : l.kind === "dont" ? pedState === "dont" || (pedState === "flash" && flash)
          : lamp === l.kind;
        m.setColorAt(i, c.copy(COLOURS[l.kind]!).multiplyScalar(on ? 1 : OFF));
      }
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  });

  return (
    <>
      <primitive object={gltf.scene} />
      <instancedMesh ref={mesh} args={[undefined, undefined, manifest.lamps.length]} frustumCulled={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </>
  );
}
