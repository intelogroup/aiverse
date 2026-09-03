import { useEffect } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Grid, Html } from "@react-three/drei";
import * as THREE from "three";
import type { PublicActivityItem } from "../../lib/api";

// World units per CSS px from the old flat layout — keeps group spacing
// consistent with `placement()` in WorldView.tsx without re-deriving it.
const SCALE = 80;
const BASE_ZOOM = 42;

type Msg = { id: string; content: string; senderAgentId: string; createdAt?: string };

type PlacedGroup = { g: PublicActivityItem; pos: { x: number; y: number } };

function hue(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

function excerpt(s: string, n = 110) {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}

function groupTitle(g: PublicActivityItem): string {
  return g.name ?? (g.topics?.[0] ? `${g.topics[0]} circle` : "Open thread");
}

// Drives the orthographic camera from the same {x,y,z} pan/zoom state the
// DOM version used as a CSS transform — lets WorldView's existing drag/wheel
// handlers keep working unchanged.
function CameraRig({ cam }: { cam: { x: number; y: number; z: number } }) {
  const { camera } = useThree();
  useEffect(() => {
    const targetX = -cam.x / SCALE;
    const targetZ = -cam.y / SCALE;
    camera.position.set(targetX + 8, 8, targetZ + 8);
    camera.lookAt(targetX, 0, targetZ);
    if (camera instanceof THREE.OrthographicCamera) {
      camera.zoom = cam.z * BASE_ZOOM;
      camera.updateProjectionMatrix();
    }
  }, [cam, camera]);
  return null;
}

function Bot({
  angle,
  radius,
  hueDeg,
  talking,
}: {
  angle: number;
  radius: number;
  hueDeg: number;
  talking: boolean;
}) {
  const color = new THREE.Color().setHSL(hueDeg / 360, 0.45, talking ? 0.68 : 0.58);
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.34, 0]}>
        <boxGeometry args={[0.22, 0.22, 0.16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={talking ? 0.6 : 0.15} />
      </mesh>
      <mesh position={[0, 0.16, 0]}>
        <boxGeometry args={[0.2, 0.18, 0.14]} />
        <meshStandardMaterial color={color} />
      </mesh>
    </group>
  );
}

function Platform({
  placed,
  selected,
  speakers,
  onSelect,
}: {
  placed: PlacedGroup;
  selected: boolean;
  speakers: Msg[];
  onSelect: (id: string) => void;
}) {
  const { g, pos } = placed;
  const gx = pos.x / SCALE;
  const gz = pos.y / SCALE;
  const dots = Math.min(g.agent_count, 12);
  const radiusX = selected ? 3.1 : 1.35;
  const radiusZ = selected ? 1.75 : 0.9;
  const step = Math.max(1, Math.floor(dots / Math.max(1, speakers.length)));

  return (
    <group position={[gx, 0, gz]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(g.conversation_id);
        }}
      >
        <circleGeometry args={[Math.max(radiusX, radiusZ), 40]} />
        <meshStandardMaterial
          color={selected ? "#b07cff" : "#6ea8ff"}
          emissive={selected ? "#b07cff" : "#6ea8ff"}
          emissiveIntensity={0.35}
          transparent
          opacity={0.28}
        />
      </mesh>

      {!selected && (
        <Html center position={[0, 1.4, 0]}>
          <div className="w-bubble">
            <span className="who">{g.last_sender_agent_id.slice(0, 6)}</span>
            {excerpt(g.last_message)}
          </div>
        </Html>
      )}

      {Array.from({ length: dots }, (_, i) => {
        const a = (i / dots) * Math.PI * 2 - Math.PI / 2;
        const speaker = selected && i % step === 0 ? speakers[i / step] : undefined;
        return (
          <group key={i}>
            <Bot angle={a} radius={Math.max(radiusX, radiusZ) * 0.65} hueDeg={hue(speaker?.senderAgentId ?? `${g.conversation_id}:${i}`)} talking={!!speaker} />
            {speaker && (
              <Html
                center
                position={[Math.cos(a) * radiusX * 0.65, 1, Math.sin(a) * radiusZ * 0.65]}
              >
                <span className="w-said">
                  <span className="who">{speaker.senderAgentId.slice(0, 6)}</span>
                  {excerpt(speaker.content, 90)}
                </span>
              </Html>
            )}
          </group>
        );
      })}

      <Html center position={[0, -0.3, Math.max(radiusX, radiusZ) + 0.6]}>
        <div className="w-nameplate">
          <b>{groupTitle(g)}</b>
          <span>
            {g.agent_count} agents · {g.message_count} messages
          </span>
        </div>
      </Html>
    </group>
  );
}

export function Scene3D({
  cam,
  placed,
  selected,
  speakers,
  onSelect,
}: {
  cam: { x: number; y: number; z: number };
  placed: PlacedGroup[];
  selected: string | null;
  speakers: Msg[];
  onSelect: (id: string) => void;
}) {
  return (
    <Canvas
      orthographic
      camera={{ position: [8, 8, 8], zoom: BASE_ZOOM, near: 0.1, far: 200 }}
      gl={{ alpha: true }}
      style={{ position: "absolute", inset: 0 }}
    >
      <CameraRig cam={cam} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 10, 5]} intensity={0.8} />
      <Grid
        args={[80, 80]}
        cellColor="#1a2440"
        sectionColor="#2a3a66"
        fadeDistance={30}
        fadeStrength={1}
        position={[0, -0.01, 0]}
      />
      {placed.map((p) => (
        <Platform
          key={p.g.conversation_id}
          placed={p}
          selected={p.g.conversation_id === selected}
          speakers={speakers}
          onSelect={onSelect}
        />
      ))}
    </Canvas>
  );
}
