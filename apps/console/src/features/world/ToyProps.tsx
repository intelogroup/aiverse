import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { InteractController } from "./interactables";
import { ritualAt } from "./rituals";
import { TOY_EFFECT_S, TOY_GROUND_Y, danceLevel, toyCenter, toyDefs, toyId } from "./toys";

const NEAR = 80; // only animate when the camera is within this many metres
const add = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false } as const;

/** Registers the toys with the interact controller and draws them. Everything is a few primitives: cheap and in-canvas, so recordings see it. */
export function ToyProps({ interact }: { interact: InteractController }) {
  const { camera } = useThree();
  const flips = useRef(new Map<string, number>());
  const clock = useRef(0);
  useEffect(() => {
    interact.register(toyDefs(), "toys");
    return interact.subscribe((id, on) => { if (on || id.startsWith("toy-")) flips.current.set(id, clock.current); });
  }, [interact]);

  const tiles = useRef<THREE.InstancedMesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const disc = useRef<THREE.Mesh>(null);
  const sparks = useRef<THREE.Points>(null);
  const flash = useRef<THREE.Mesh>(null);
  const sparkGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(90 * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(90 * 3), 3));
    return g;
  }, []);
  const velocities = useMemo(() => Array.from({ length: 90 }, (_, i) => {
    const a = (i / 90) * Math.PI * 2 * 7, up = 0.55 + ((i * 37) % 100) / 100 * 0.45, sp = 4 + ((i * 53) % 100) / 100 * 5;
    return new THREE.Vector3(Math.cos(a) * sp * 0.45, up * sp, Math.sin(a) * sp * 0.45);
  }), []);
  const dot = useMemo(() => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d")!, grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "#fff"); grad.addColorStop(0.35, "rgba(255,255,255,.6)"); grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }, []);
  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const col = useMemo(() => new THREE.Color(), []);

  useFrame((_, delta) => {
    clock.current += delta;
    const t = clock.current;
    const [dx, dz] = toyCenter("dance");
    if (Math.hypot(camera.position.x - dx, camera.position.z - dz) > NEAR) return;
    const since = (id: string) => t - (flips.current.get(id) ?? -99);

    // Dance floor: 4x4 tiles whose colours chase each other; more dancers, brighter and faster.
    const tm = tiles.current;
    if (tm) {
      const level = danceLevel(interact.isOn(toyId("dance")), interact.actorsNear(dx, dz, 3.2), ritualAt(Date.now()).ritual.id === "dance" && ritualAt(Date.now()).active);
      for (let i = 0; i < 16; i++) {
        const cx = (i % 4) - 1.5, cz = Math.floor(i / 4) - 1.5;
        const hue = (t * 0.15 * (0.5 + level) + (cx + cz) * 0.08) % 1;
        const lit = level === 0 ? 0.04 : 0.25 + 0.2 * level * (0.5 + 0.5 * Math.sin(t * (2 + level * 2) + i));
        tm.setColorAt(i, col.setHSL(hue, 0.9, Math.min(0.75, lit)));
        m4.makeTranslation(dx + cx * 1.0, 0.04, dz + cz * 1.0);
        tm.setMatrixAt(i, m4);
      }
      tm.instanceMatrix.needsUpdate = true;
      if (tm.instanceColor) tm.instanceColor.needsUpdate = true;
    }
    // Gong: expanding ring + wobbling disc.
    const gs = since(toyId("gong")), [gx, gz] = toyCenter("gong");
    if (ring.current) {
      const k = gs / TOY_EFFECT_S.gong, vis = k >= 0 && k < 1;
      ring.current.visible = vis;
      if (vis) { ring.current.scale.setScalar(0.5 + k * 7); (ring.current.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.8; }
    }
    if (disc.current) { disc.current.rotation.z = gs < 1.5 ? Math.sin(gs * 40) * 0.08 * (1 - gs / 1.5) : 0; disc.current.position.set(gx, 1.6, gz); }
    // Fireworks: ballistic sparks.
    const fs = since(toyId("fireworks")), [fx, fz] = toyCenter("fireworks");
    const sp = sparks.current;
    if (sp) {
      const vis = fs >= 0 && fs < TOY_EFFECT_S.fireworks;
      sp.visible = vis;
      if (vis) {
        const pos = sparkGeo.getAttribute("position") as THREE.BufferAttribute, c = sparkGeo.getAttribute("color") as THREE.BufferAttribute;
        const burst = Math.floor((flips.current.get(toyId("fireworks")) ?? 0) * 10);
        for (let i = 0; i < 90; i++) {
          const v = velocities[i]!;
          pos.setXYZ(i, fx + v.x * fs, 0.3 + v.y * fs - 4.5 * fs * fs, fz + v.z * fs);
          col.setHSL(((i % 6) / 6 + burst * 0.13) % 1, 1, 0.5).multiplyScalar(1 - fs / TOY_EFFECT_S.fireworks);
          c.setXYZ(i, col.r, col.g, col.b);
        }
        pos.needsUpdate = c.needsUpdate = true;
      }
    }
    // Photo booth: a white flash.
    const ps = since(toyId("photo"));
    if (flash.current) {
      const vis = ps >= 0 && ps < TOY_EFFECT_S.photo;
      flash.current.visible = vis;
      if (vis) (flash.current.material as THREE.MeshBasicMaterial).opacity = 1 - ps / TOY_EFFECT_S.photo;
    }
  });

  const [gx, gz] = toyCenter("gong"), [px, pz] = toyCenter("photo"), [fx, fz] = toyCenter("fireworks");
  return (
    <group name="verse:toys" position-y={TOY_GROUND_Y}>
      <instancedMesh ref={tiles} args={[undefined, undefined, 16]} frustumCulled={false}>
        <boxGeometry args={[0.94, 0.06, 0.94]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <mesh position={[gx - 1, 0.9, gz]}><cylinderGeometry args={[0.07, 0.07, 1.8, 8]} /><meshStandardMaterial color="#5a3b22" /></mesh>
      <mesh position={[gx + 1, 0.9, gz]}><cylinderGeometry args={[0.07, 0.07, 1.8, 8]} /><meshStandardMaterial color="#5a3b22" /></mesh>
      <mesh position={[gx, 1.82, gz]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.05, 0.05, 2.1, 8]} /><meshStandardMaterial color="#5a3b22" /></mesh>
      <mesh ref={disc} position={[gx, 1.6, gz]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.6, 0.6, 0.06, 24]} /><meshStandardMaterial color="#d4a437" metalness={0.8} roughness={0.3} /></mesh>
      <mesh ref={ring} visible={false} position={[gx, 1.6, gz]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[1, 0.03, 8, 40]} /><meshBasicMaterial color="#ffd36a" opacity={0.8} {...add} /></mesh>
      <mesh position={[fx, 0.15, fz]}><cylinderGeometry args={[0.5, 0.6, 0.3, 16]} /><meshStandardMaterial color="#3a3d52" /></mesh>
      <points ref={sparks} visible={false} geometry={sparkGeo} frustumCulled={false}><pointsMaterial size={0.45} map={dot} vertexColors {...add} /></points>
      <mesh position={[px, 1.2, pz - 0.6]}><boxGeometry args={[1.8, 2.4, 0.15]} /><meshStandardMaterial color="#8a2d5e" /></mesh>
      <mesh position={[px, 1.2, pz - 0.5]}><planeGeometry args={[1.5, 2.1]} /><meshStandardMaterial color="#f4ecf7" /></mesh>
      <mesh ref={flash} visible={false} position={[px, 1.2, pz - 0.4]}><planeGeometry args={[6, 6]} /><meshBasicMaterial color="#fff" opacity={1} {...add} /></mesh>
    </group>
  );
}
