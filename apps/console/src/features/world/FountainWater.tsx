import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

interface FountainDef {
  innerRadius: number; outerRadius: number; waterY: number; segments: number;
  jetCount: number; jetRadius: number; jetY: number; jetAngleOffset: number;
}

/** Small, repeating normal field. No image downloads, displacement or reflection passes. */
function rippleTexture() {
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
    const dx = .20 * Math.cos(3*u + 2*v) + .12 * Math.cos(5*u - 3*v);
    const dy = .14 * Math.cos(3*u + 2*v) - .09 * Math.cos(5*u - 3*v);
    const n = new THREE.Vector3(-dx, -dy, 1).normalize();
    const i = (y*size+x)*4;
    data[i] = (n.x*.5+.5)*255; data[i+1] = (n.y*.5+.5)*255;
    data[i+2] = (n.z*.5+.5)*255; data[i+3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.repeat.set(2, 2); texture.needsUpdate = true;
  return texture;
}

function Splash({ def, angle, offset }: { def: FountainDef; angle: number; offset: number }) {
  const splash = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!splash.current) return;
    const phase = (clock.elapsedTime*.65 + angle/Math.PI + offset) % 1;
    splash.current.scale.setScalar(.25 + phase*2.6);
    (splash.current.material as THREE.MeshBasicMaterial).opacity = .42*Math.pow(1-phase,1.5);
  });
  return <mesh ref={splash} name="FountainWaterSplash" rotation={[-Math.PI/2,0,0]}
    position={[(def.jetRadius+.9)*Math.cos(angle),def.waterY+.025,-(def.jetRadius+.9)*Math.sin(angle)]}>
    <ringGeometry args={[.18,.21,32]} />
    <meshBasicMaterial color="#c6ece5" transparent opacity={.25} depthWrite={false} toneMapped={false} />
  </mesh>;
}

function jetPoint(def: FountainDef, angle: number, t: number, point: THREE.Vector3) {
  const r = def.jetRadius + .9*t;
  return point.set(r*Math.cos(angle),
    THREE.MathUtils.lerp(def.jetY,def.waterY+.015,t) + .85*4*t*(1-t), -r*Math.sin(angle));
}

/** Bright beads travel down each arc, instead of leaving the streams looking like static wires. */
function FlowingDrops({ def }: { def: FountainDef }) {
  const drops = useRef<THREE.InstancedMesh>(null);
  const scratch = useMemo(() => ({ point: new THREE.Vector3(), matrix: new THREE.Matrix4() }), []);
  useFrame(({ clock }) => {
    if (!drops.current) return;
    for (let jet = 0; jet < def.jetCount; jet++) for (let bead = 0; bead < 4; bead++) {
      const t = (clock.elapsedTime*.7 + bead/4 + jet*.13) % 1;
      jetPoint(def,jet*Math.PI*2/def.jetCount+def.jetAngleOffset,t,scratch.point);
      scratch.matrix.makeScale(.045,.065,.045).setPosition(scratch.point);
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
      <tubeGeometry args={[curve, 24, .025, 5, false]} />
      <meshStandardMaterial color="#b6e4df" roughness={.32} transparent opacity={.8} depthWrite={false} />
    </mesh>
    <Splash def={def} angle={angle} offset={0} />
    <Splash def={def} angle={angle} offset={.5} />
  </>;
}

/** Fountain is independent of the district ocean and is never part of collision geometry. */
export function FountainWater() {
  const [def, setDef] = useState<FountainDef | null>(null);
  const [normal, setNormal] = useState<THREE.DataTexture | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/assets/city3-fountain.json").then(r => {
      if (!r.ok) throw new Error("Fountain metadata unavailable");
      return r.json();
    }).then((d: FountainDef) => { if (live) setDef(d); }).catch(console.error);
    const texture = rippleTexture(); setNormal(texture);
    return () => { live = false; texture.dispose(); };
  }, []);
  useFrame(({ clock }) => {
    if (normal) normal.offset.set(clock.elapsedTime*.04, clock.elapsedTime*.025);
  });
  if (!def || !normal) return null;
  return <group name="City3FountainWater">
    <mesh name="FountainWaterSurface" rotation={[-Math.PI/2,0,0]} position={[0,def.waterY,0]}>
      <ringGeometry args={[def.innerRadius,def.outerRadius,def.segments,1,0,Math.PI*2]} />
      <meshPhysicalMaterial key={normal.uuid} color="#348d91" roughness={.48} metalness={0}
        normalMap={normal} normalScale={[.8,.8]} envMapIntensity={.65}
        ior={1.333} specularIntensity={.5} clearcoat={.2} clearcoatRoughness={.45} />
    </mesh>
    {Array.from({ length: def.jetCount }, (_, i) =>
      <Jet key={i} def={def} angle={i*Math.PI*2/def.jetCount+def.jetAngleOffset} />)}
    <FlowingDrops def={def} />
  </group>;
}
