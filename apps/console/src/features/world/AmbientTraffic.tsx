import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import { assetUrl } from "../../lib/assetUrl";
import { BODY_REMY } from "./bodies";
import { CastFigure } from "./CastFigure";
import { extendGltf } from "./gltfExtensions";
import type { AgentFrame } from "./locomotion";
import { newWalkerFrame } from "./walkerBody";
import { PED_SPEED, sample, spawnCars, spawnWalkers, stepCars, stepWalkers } from "./ambientTraffic";

// Ambient Bazaar life: cars looping the street grid and "business" pedestrians (the Remy body) crossing at the zebras.
// Both read the shared signal controller (trafficSignals.ts, a function of the wall clock), so they stop for the same red
// that every viewer sees. Client-side only and not synchronised between viewers: dressing, not a simulation of record.
const CAR_MODEL = assetUrl("/assets/car-concept.glb");
const GROUND_Y = 0.2;          // Bazaar walking surface (plan.json walk_z)
const CAR_GROUND = 0.159;      // wheel bottoms sit this far below the car origin (BazaarCar.tsx)

const nowS = () => Date.now() / 1000;

function Cars() {
  const gl = useThree((s) => s.gl);
  const gltf = useGLTF(CAR_MODEL, true, true, extendGltf(gl));
  const cars = useMemo(() => spawnCars(2), []);
  const groups = useRef<(THREE.Group | null)[]>([]);
  const models = useMemo(() => cars.map(() => gltf.scene.clone()), [cars, gltf]);
  useFrame((_, delta) => {
    stepCars(cars, Math.min(delta, 0.1), nowS());
    cars.forEach((c, i) => {
      const g = groups.current[i];
      if (!g) return;
      const p = sample(c.loop, c.s);
      g.position.set(p.x, GROUND_Y + CAR_GROUND, -p.y);
      g.rotation.y = Math.atan2(p.dx, -p.dy);     // three heading: 0 faces +z (= plan -y)
    });
  });
  return <>{cars.map((c, i) => <group key={i} ref={(g) => { groups.current[i] = g; }}><primitive object={models[i]} /></group>)}</>;
}

function Pedestrians() {
  const walkers = useMemo(() => spawnWalkers(), []);
  const frames = useRef<AgentFrame[]>(walkers.map((w) => ({ ...newWalkerFrame(w.cw.a[0], -w.cw.a[1], 0), gait: { reverse: false } })));
  useFrame((_, delta) => {
    stepWalkers(walkers, Math.min(delta, 0.1), nowS());
    walkers.forEach((w, i) => {
      const f = frames.current[i];
      f.position[0] = w.x; f.position[1] = -w.y;
      f.heading = w.heading;
      f.speed = w.moving ? PED_SPEED : 0;
      f.state = w.moving ? "walk" : "idle";
      f.velocity[0] = w.moving ? Math.sin(w.heading) * PED_SPEED : 0;
      f.velocity[1] = w.moving ? Math.cos(w.heading) * PED_SPEED : 0;
    });
  });
  return (
    <group position={[0, GROUND_Y, 0]}>
      {walkers.map((w, i) => (
        <Suspense key={i} fallback={null}>
          <CastFigure framesRef={frames} index={i} baseY={0} home={[w.cw.a[0], 0, -w.cw.a[1]]} body={BODY_REMY} />
        </Suspense>
      ))}
    </group>
  );
}

export function AmbientTraffic() {
  return <><Suspense fallback={null}><Cars /></Suspense><Pedestrians /></>;
}
