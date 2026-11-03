import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Html } from "@react-three/drei";
import * as THREE from "three";
import type { PublicActivityItem } from "../../lib/api";
import { createPlatformCrowd, type AgentFrame, type PlatformCrowd } from "./locomotion";
import { RiggedFigure } from "./RiggedFigure";

// World units per CSS px from the old flat layout — keeps group spacing
// consistent with `placement()` in WorldView.tsx without re-deriving it.
const SCALE = 80;
const BASE_ZOOM = 42;

// Locomotion (see locomotion.ts): every platform's figures are driven by a
// Recast crowd walking a disc in "crowd space". The crowd disc is sized for
// the SELECTED platform disc (radius 3.1) at 80% so figures keep off the
// rim; rendered positions are scaled by discRadius / SELECTED_DISC_RADIUS,
// so the same crowd fits the platform selected or not, and figures ride
// inside the platform group (platform-local coordinates throughout).
const SELECTED_DISC_RADIUS = 3.1;
const CROWD_RADIUS = SELECTED_DISC_RADIUS * 0.8;
// Where figures stand before the crowd's first frame (and where crowd
// agents spawn): a ring at this fraction of the disc radius, matching the
// pre-locomotion static layout so the swap doesn't visibly jump.
const RING_FRACTION = 0.58;

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

// The procedural box figure (head + body). Positioning is owned by the
// parent group — this is just the body.
function BotFigure({ hueDeg, talking }: { hueDeg: number; talking: boolean }) {
  const color = new THREE.Color().setHSL(hueDeg / 360, 0.45, talking ? 0.68 : 0.58);
  return (
    <>
      <mesh position={[0, 0.34, 0]}>
        <boxGeometry args={[0.22, 0.22, 0.16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={talking ? 0.6 : 0.15} />
      </mesh>
      <mesh position={[0, 0.16, 0]}>
        <boxGeometry args={[0.2, 0.18, 0.14]} />
        <meshStandardMaterial color={color} />
      </mesh>
    </>
  );
}

function Platform({
  placed,
  selected,
  speakers,
  onSelect,
  rigged,
}: {
  placed: PlacedGroup;
  selected: boolean;
  speakers: Msg[];
  onSelect: (id: string) => void;
  /** Host the ?rigged=1 KayKit figure as figure 0 (largest platform only). */
  rigged: boolean;
}) {
  const { g, pos } = placed;
  const gx = pos.x / SCALE;
  const gz = pos.y / SCALE;
  const dots = Math.min(g.agent_count, 12);
  const radiusX = selected ? 3.1 : 1.35;
  const radiusZ = selected ? 1.75 : 0.9;
  const discRadius = Math.max(radiusX, radiusZ);
  const renderScale = discRadius / SELECTED_DISC_RADIUS;
  const step = Math.max(1, Math.floor(dots / Math.max(1, speakers.length)));

  // --- Crowd lifecycle -----------------------------------------------------
  // One crowd per conversation, created once (async: the Recast WASM module
  // initializes on first use). Figure-count changes reconcile through
  // setAgentCount — the crowd is never rebuilt for a data poll.
  const crowdRef = useRef<PlatformCrowd | null>(null);
  const framesRef = useRef<AgentFrame[]>([]);
  const botRefs = useRef<Array<THREE.Group | null>>([]);
  const leanRefs = useRef<Array<THREE.Group | null>>([]);
  const [crowdReady, setCrowdReady] = useState(false);

  useEffect(() => {
    let live = true;
    const initialPositions: [number, number][] = Array.from({ length: dots }, (_, i) => {
      const a = (i / Math.max(1, dots)) * Math.PI * 2 - Math.PI / 2;
      const r = RING_FRACTION * SELECTED_DISC_RADIUS;
      return [Math.cos(a) * r, Math.sin(a) * r];
    });
    createPlatformCrowd(CROWD_RADIUS, dots, { initialPositions })
      .then((c) => {
        if (!live) {
          c.dispose();
          return;
        }
        crowdRef.current = c;
        setCrowdReady(true);
      })
      .catch(() => {});
    return () => {
      live = false;
      crowdRef.current?.dispose();
      crowdRef.current = null;
    };
    // The crowd is keyed to the conversation only; `dots` at creation time
    // is just the initial count (later changes reconcile via the effect
    // below), so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.conversation_id]);

  useEffect(() => {
    if (crowdReady) crowdRef.current?.setAgentCount(dots);
  }, [dots, crowdReady]);

  // Step the crowd and write figure transforms imperatively — no React
  // re-render per frame. Walking figures get a small procedural bob + lean
  // so the motion reads on the unrigged box figures.
  useFrame((state, delta) => {
    const crowd = crowdRef.current;
    if (!crowd) return;
    const frames = crowd.step(Math.min(delta, 0.05));
    framesRef.current = frames;
    const t = state.clock.elapsedTime;
    frames.forEach((f, i) => {
      if (rigged && i === 0) return; // RiggedFigure drives itself from framesRef
      const grp = botRefs.current[i];
      if (!grp) return;
      const walking = f.state === "walk";
      const bob = walking ? Math.abs(Math.sin(t * 9 + i * 1.7)) * 0.05 : 0;
      grp.position.set(f.position[0] * renderScale, bob, f.position[1] * renderScale);
      grp.rotation.y = f.heading;
      const lean = leanRefs.current[i];
      if (lean) lean.rotation.x = walking ? 0.1 : 0;
    });
  });

  return (
    <group position={[gx, 0, gz]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(g.conversation_id);
        }}
      >
        <circleGeometry args={[discRadius, 40]} />
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
        const figHue = hue(speaker?.senderAgentId ?? `${g.conversation_id}:${i}`);
        const ringR = RING_FRACTION * discRadius;
        const home: [number, number, number] = [Math.cos(a) * ringR, 0, Math.sin(a) * ringR];
        const bubble = speaker ? (
          <Html center position={[0, 1, 0]}>
            <span className="w-said">
              <span className="who">{speaker.senderAgentId.slice(0, 6)}</span>
              {excerpt(speaker.content, 90)}
            </span>
          </Html>
        ) : null;

        if (rigged && i === 0) {
          return (
            <Suspense
              key={i}
              fallback={
                <group position={home}>
                  <BotFigure hueDeg={figHue} talking={false} />
                </group>
              }
            >
              <RiggedFigure framesRef={framesRef} index={0} scale={renderScale} home={home}>
                {bubble}
              </RiggedFigure>
            </Suspense>
          );
        }

        return (
          <group
            key={i}
            ref={(el) => {
              botRefs.current[i] = el;
            }}
            position={home}
          >
            <group
              ref={(el) => {
                leanRefs.current[i] = el;
              }}
            >
              <BotFigure hueDeg={figHue} talking={!!speaker} />
            </group>
            {bubble}
          </group>
        );
      })}

      <Html center position={[0, -0.3, discRadius + 0.6]}>
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
  // ?rigged=1 swaps the largest platform's first figure for the rigged
  // KayKit Knight (clip-driven). Off by default: the 3.7 MB GLB is over
  // the console's delivery budget for a default load.
  const riggedMode = useMemo(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("rigged") === "1",
    [],
  );
  const riggedId = useMemo(() => {
    if (!riggedMode || placed.length === 0) return null;
    let best = placed[0];
    for (const p of placed) if (p.g.agent_count > best.g.agent_count) best = p;
    return best.g.conversation_id;
  }, [riggedMode, placed]);

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
          rigged={p.g.conversation_id === riggedId}
        />
      ))}
    </Canvas>
  );
}
