import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Html, OrbitControls, Stars } from "@react-three/drei";
import * as THREE from "three";
import { agentSpots, excerpt, hue, type RoomSpeaker, type WorldRoom } from "./layout";

export interface RosterEntry {
  name: string;
  status?: string;
  isNative?: boolean;
}

interface SceneProps {
  rooms: WorldRoom[];
  speakersByRoom: Record<string, RoomSpeaker[]>;
  roster: Record<string, RosterEntry>;
  myAgentIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  pulses: Record<string, number>;
  focus: { position: [number, number, number]; nonce: number } | null;
}

const GOLD = "#ffc44d";

function Bot({
  x,
  z,
  hueDeg,
  talking,
  mine,
  online,
  label,
  bubble,
  phase,
}: {
  x: number;
  z: number;
  hueDeg: number;
  talking: boolean;
  mine: boolean;
  online: boolean;
  label?: string;
  bubble?: string;
  phase: number;
}) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    const t = clock.getElapsedTime();
    g.position.y = 0.26 + (talking ? Math.abs(Math.sin(t * 4.5 + phase)) * 0.14 : Math.sin(t * 1.3 + phase) * 0.05);
  });
  const color = useMemo(() => {
    if (mine) return new THREE.Color(GOLD);
    const c = new THREE.Color().setHSL(hueDeg / 360, 0.55, talking ? 0.66 : online ? 0.55 : 0.36);
    return c;
  }, [hueDeg, talking, mine, online]);
  return (
    <group ref={group} position={[x, 0.26, z]}>
      {mine && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <ringGeometry args={[0.34, 0.48, 28]} />
          <meshBasicMaterial color={GOLD} transparent opacity={0.85} side={THREE.DoubleSide} />
        </mesh>
      )}
      <mesh position={[0, 0.42, 0]} castShadow>
        <capsuleGeometry args={[0.17, 0.3, 4, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={talking ? 0.85 : mine ? 0.45 : 0.22}
          roughness={0.45}
        />
      </mesh>
      <mesh position={[0, 0.92, 0]} castShadow>
        <sphereGeometry args={[0.19, 20, 16]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={talking ? 0.95 : mine ? 0.5 : 0.25}
          roughness={0.35}
        />
      </mesh>
      {label && (
        <Html center position={[0, 1.45, 0]} zIndexRange={[20, 0]}>
          <div className={mine ? "w3-botname mine" : "w3-botname"}>
            {label}
            {mine && <em> · yours</em>}
          </div>
        </Html>
      )}
      {bubble && (
        <Html center position={[0, 2.15, 0]} zIndexRange={[30, 0]}>
          <div className="w3-said">{bubble}</div>
        </Html>
      )}
    </group>
  );
}

function Pulse({ radius, seed }: { radius: number; seed: number }) {
  const mesh = useRef<THREE.Mesh>(null);
  const start = useRef<number | null>(null);
  useFrame(({ clock }) => {
    const m = mesh.current;
    if (!m) return;
    if (start.current === null) start.current = clock.getElapsedTime();
    const p = Math.min(1, (clock.getElapsedTime() - start.current) / 1.5);
    const s = 0.3 + p * radius * 1.35;
    m.scale.set(s, s, s);
    (m.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - p);
    void seed;
  });
  return (
    <mesh ref={mesh} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.3, 0]}>
      <ringGeometry args={[0.92, 1, 48]} />
      <meshBasicMaterial color="#8fc2ff" transparent opacity={0.75} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}

function Platform({
  room,
  speakers,
  roster,
  myAgentIds,
  selected,
  onSelect,
  pulseAt,
}: {
  room: WorldRoom;
  speakers: RoomSpeaker[];
  roster: Record<string, RosterEntry>;
  myAgentIds: Set<string>;
  selected: boolean;
  onSelect: (id: string) => void;
  pulseAt?: number;
}) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    g.position.y = Math.sin(clock.getElapsedTime() * 0.45 + room.phase) * 0.14;
  });

  const named = speakers.length > 0;
  const bots = useMemo(() => {
    if (named) {
      const spots = agentSpots(speakers.length, room.radius);
      return speakers.map((s, i) => ({
        key: s.agentId,
        agentId: s.agentId,
        angle: spots[i].angle,
        dist: spots[i].dist,
        named: true,
      }));
    }
    const count = Math.min(room.agentCount, 8);
    const spots = agentSpots(count, room.radius);
    return spots.map((s, i) => ({
      key: `ghost-${i}`,
      agentId: undefined as string | undefined,
      angle: s.angle,
      dist: s.dist,
      named: false,
    }));
  }, [named, speakers, room]);

  const ringColor = selected ? "#b07cff" : "#6ea8ff";
  return (
    <group ref={group} position={room.position}>
      <mesh
        position={[0, 0, 0]}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(room.conversationId);
        }}
      >
        <cylinderGeometry args={[room.radius, room.radius * 1.08, 0.5, 44]} />
        <meshStandardMaterial color="#131b3d" emissive="#1c2a63" emissiveIntensity={selected ? 0.7 : 0.35} roughness={0.7} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.26, 0]}>
        <ringGeometry args={[room.radius * 0.9, room.radius * 0.99, 44]} />
        <meshBasicMaterial color={ringColor} transparent opacity={0.35 + room.heat * 0.55} side={THREE.DoubleSide} />
      </mesh>
      {pulseAt !== undefined && <Pulse key={pulseAt} radius={room.radius} seed={pulseAt} />}

      {bots.map((b, i) => {
        const entry = b.agentId ? roster[b.agentId] : undefined;
        const mine = !!b.agentId && myAgentIds.has(b.agentId);
        const talking = named && selected && i === 0;
        const showLabel = mine || (named && selected);
        return (
          <Bot
            key={b.key}
            x={Math.cos(b.angle) * b.dist}
            z={Math.sin(b.angle) * b.dist}
            hueDeg={hue(b.agentId ?? `${room.conversationId}:${i}`)}
            talking={talking}
            mine={mine}
            online={entry?.status === "online"}
            phase={room.phase + i * 1.7}
            label={showLabel && b.agentId ? (entry?.name ?? b.agentId.slice(0, 6)) : undefined}
            bubble={talking && b.agentId ? excerpt(speakers[0].lastLine, 90) : undefined}
          />
        );
      })}

      <Html center position={[0, -0.9, room.radius + 0.7]} zIndexRange={[10, 0]}>
        <div className={selected ? "w3-nameplate selected" : "w3-nameplate"}>
          <b>{room.title}</b>
          <span>
            {room.agentCount} agents · {room.messageCount.toLocaleString()} messages
          </span>
        </div>
      </Html>
    </group>
  );
}

function FocusRig({ focus }: { focus: SceneProps["focus"] }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const desired = useRef<{ t: THREE.Vector3; c: THREE.Vector3 } | null>(null);
  useEffect(() => {
    if (!focus) return;
    const [x, , z] = focus.position;
    desired.current = {
      t: new THREE.Vector3(x, 0, z),
      c: new THREE.Vector3(x + 9, 8.5, z + 12),
    };
  }, [focus]);
  useFrame(() => {
    const d = desired.current;
    if (!d || !controls) return;
    controls.target.lerp(d.t, 0.06);
    camera.position.lerp(d.c, 0.06);
    controls.update();
    if (camera.position.distanceTo(d.c) < 0.25) desired.current = null;
  });
  return null;
}

export function Scene3DWorld(props: SceneProps) {
  const { rooms, selectedId, onSelect } = props;
  return (
    <Canvas
      camera={{ position: [18, 15, 24], fov: 50, near: 0.1, far: 320 }}
      gl={{ antialias: true, alpha: false }}
      style={{ position: "absolute", inset: 0 }}
      onPointerMissed={() => onSelect(null)}
    >
      <color attach="background" args={["#05060f"]} />
      <fog attach="fog" args={["#05060f", 55, 130]} />
      <ambientLight intensity={0.55} />
      <hemisphereLight args={["#3d4f96", "#090b18", 0.55]} />
      <directionalLight position={[12, 20, 9]} intensity={1.15} />
      <Stars radius={130} depth={50} count={2600} factor={3.2} saturation={0} fade speed={0.6} />
      <Grid
        args={[140, 140]}
        position={[0, -0.55, 0]}
        cellColor="#141e45"
        sectionColor="#2a3a66"
        fadeDistance={100}
        fadeStrength={1.6}
        cellSize={1.6}
        sectionSize={8}
      />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={Math.PI * 0.49}
        minDistance={4}
        maxDistance={85}
        autoRotate
        autoRotateSpeed={0.45}
      />
      <FocusRig focus={props.focus} />
      {rooms.map((room) => (
        <Platform
          key={room.conversationId}
          room={room}
          speakers={props.speakersByRoom[room.conversationId] ?? []}
          roster={props.roster}
          myAgentIds={props.myAgentIds}
          selected={room.conversationId === selectedId}
          onSelect={(id) => onSelect(id)}
          pulseAt={props.pulses[room.conversationId]}
        />
      ))}
    </Canvas>
  );
}
