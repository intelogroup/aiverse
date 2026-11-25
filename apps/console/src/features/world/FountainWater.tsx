import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { assetUrl } from "../../lib/assetUrl";
import { createFountainBasinMaterial } from "./basinWater";
import { oceanTime } from "./districtSky";
import { useTileEpoch } from "./tileScenes";

interface FountainDef {
  innerRadius: number; outerRadius: number; waterY: number; segments: number;
  jetCount: number; jetRadius: number; jetY: number; jetAngleOffset: number;
  jetRange: number; jetFlightTime: number;
}

const architectureUrl = assetUrl("/assets/fountain-architecture.glb");

function FountainArchitecture() {
  const { scene } = useGLTF(architectureUrl);
  const world = useThree((state) => state.scene);
  const epoch = useTileEpoch();
  // Hide only the previous decorative coping after the replacement is ready.
  // The planters share its node tree, so hiding the parent would hide them too.
  useLayoutEffect(() => {
    const hidden: THREE.Material[] = [];
    world.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material.visible && /^PlazaFountainGarden_[01]$/.test(material.name)) {
          hidden.push(material);
          material.visible = false;
        }
      }
    });
    return () => { for (const material of hidden) material.visible = true; };
  }, [world, epoch]);
  return <primitive object={scene} />;
}

function Splash({ def, angle, offset }: { def: FountainDef; angle: number; offset: number }) {
  const splash = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!splash.current) return;
    const phase = (clock.elapsedTime*.65 + angle/Math.PI + offset) % 1;
    splash.current.scale.setScalar(.25 + phase*2.2);
    (splash.current.material as THREE.MeshBasicMaterial).opacity = .42*Math.pow(1-phase,1.5);
  });
  const landing = useMemo(() => jetPoint(def, angle, 1, new THREE.Vector3()), [def, angle]);
  return <mesh ref={splash} name="FountainWaterSplash" rotation={[-Math.PI/2,0,0]} position={landing}>
    <ringGeometry args={[.18,.21,32]} />
    <meshBasicMaterial color="#c6ece5" transparent opacity={.25} depthWrite={false} toneMapped={false} />
  </mesh>;
}

function jetPoint(def: FountainDef, angle: number, t: number, point: THREE.Vector3) {
  const r = def.jetRadius + def.jetRange * t;
  // Constant horizontal velocity and gravity, with endpoint on the water.
  const arc = 0.5 * 9.81 * def.jetFlightTime ** 2 * t * (1 - t);
  return point.set(r*Math.cos(angle),
    THREE.MathUtils.lerp(def.jetY, def.waterY + .015, t) + arc, -r*Math.sin(angle));
}

/** Bright beads travel down each arc, instead of leaving the streams looking like static wires. */
function FlowingDrops({ def }: { def: FountainDef }) {
  const drops = useRef<THREE.InstancedMesh>(null);
  const scratch = useMemo(() => ({ point: new THREE.Vector3(), matrix: new THREE.Matrix4() }), []);
  useFrame(({ clock }) => {
    if (!drops.current) return;
    for (let jet = 0; jet < def.jetCount; jet++) for (let bead = 0; bead < 4; bead++) {
      const t = (clock.elapsedTime / def.jetFlightTime + bead/4 + jet*.13) % 1;
      jetPoint(def,jet*Math.PI*2/def.jetCount+def.jetAngleOffset,t,scratch.point);
      scratch.matrix.makeScale(.028,.038,.028).setPosition(scratch.point);
      drops.current.setMatrixAt(jet*4+bead,scratch.matrix);
    }
    drops.current.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={drops} name="FountainWaterDrops" args={[undefined,undefined,def.jetCount*4]} frustumCulled={false}>
    <sphereGeometry args={[1,8,5]} />
    <meshBasicMaterial color="#d2eee8" toneMapped={false} />
  </instancedMesh>;
}

function Jet({ def, angle }: { def: FountainDef; angle: number }) {
  const curve = useMemo(() => {
    const points = Array.from({ length: 25 }, (_, i) => jetPoint(def,angle,i/24,new THREE.Vector3()));
    return new THREE.CatmullRomCurve3(points);
  }, [def, angle]);
  return <>
    <mesh name="FountainWaterJet">
      <tubeGeometry args={[curve, 24, .032, 6, false]} />
      <meshStandardMaterial color="#b6e4df" roughness={.18} transparent opacity={.58} depthWrite={false} />
    </mesh>
    <Splash def={def} angle={angle} offset={0} />
    <Splash def={def} angle={angle} offset={.5} />
  </>;
}

/** Fountain is independent of the district ocean and is never part of collision geometry. */
export function FountainWater() {
  const [def, setDef] = useState<FountainDef | null>(null);
  const material = useMemo(() => def
    ? createFountainBasinMaterial(def.innerRadius, def.outerRadius, oceanTime)
    : null, [def]);
  useEffect(() => () => material?.dispose(), [material]);
  useEffect(() => {
    let live = true;
    fetch("/assets/city3-fountain.json").then(r => {
      if (!r.ok) throw new Error("Fountain metadata unavailable");
      return r.json();
    }).then((d: FountainDef) => { if (live) setDef(d); }).catch(console.error);
    return () => { live = false; };
  }, []);
  if (!def || !material) return null;
  return <group name="City3FountainWater">
    <Suspense fallback={null}><FountainArchitecture /></Suspense>
    <mesh name="FountainWaterSurface" material={material} rotation={[-Math.PI/2,0,0]} position={[0,def.waterY,0]}>
      <ringGeometry args={[def.innerRadius,def.outerRadius,def.segments,1,0,Math.PI*2]} />
    </mesh>
    {Array.from({ length: def.jetCount }, (_, i) =>
      <Jet key={i} def={def} angle={i*Math.PI*2/def.jetCount+def.jetAngleOffset} />)}
    <FlowingDrops def={def} />
  </group>;
}
