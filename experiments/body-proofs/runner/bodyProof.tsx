// PROOF HARNESS — not part of the product. Consolidated from the three
// per-body harnesses of the 2026-11-11 roster-clearing pass (Cipher, Eve,
// Skeleton Warrior — see ../README.md and the per-body VERDICT.md files in
// this experiment). One parametrized stage: pick the body by registry id.
//
// Renders the real CastFigure wearing the chosen body exactly as registered
// on main (display scale, clips, walkSpeed all from
// packages/world-sim/src/bodies.ts via the console's re-export), so a
// headless browser can shoot the eyeball check:
//   ?body=<registry id>&view=front   Idle, camera on +Z
//   ?body=<registry id>&view=side    Idle, camera on +X
//   ?body=<registry id>&view=walk    Walk clip driven through the normal
//                 crowd-frame path (state "walk", speed = the body's
//                 registered walkSpeed)
// On ready it also measures the POSED figure in world units (skinned-mesh
// bounds + bone heights) into window.__MEASURE. Per-mesh bounds and the
// bone dump are included because some bodies split their nominal: e.g.
// skeleton-warrior's horned helmet rides ~0.33 m (displayed) above the
// skull, so the whole-figure box reads the horns while the body-only
// height is what compares against the registry nominal; and its registry
// hipsY is defined on the upperleg joints, not the bone named "hips".
//
// To run: copy this file to apps/console/src/proof/bodyProof.tsx and
// body-proof.html to apps/console/ in a scratch checkout, start vite,
// then drive it with runner/run_proof.py. Never commit those copies.
import { createRoot } from "react-dom/client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useRef } from "react";
import * as THREE from "three";
import { CastFigure } from "../features/world/CastFigure";
import { BODIES } from "../features/world/bodies";
import { newWalkerFrame } from "../features/world/walkerBody";
import type { AgentFrame } from "../features/world/locomotion";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "front";
const bodyId = params.get("body") ?? "";
const body = BODIES[bodyId];

type MeshBound = { name: string; minY: number; maxY: number; heightM: number };
type BoneY = { name: string; y: number };
type Measure = {
  body: string;
  heightM: number;
  minY: number;
  maxY: number;
  hipsY: number | null;
  headY: number | null;
  clip: string | null;
  meshes: MeshBound[];
  bones: BoneY[];
  registered: { scale: number; hipsY: number; walkSpeed: number };
};
declare global {
  interface Window {
    __PROOF_READY?: boolean;
    __PROOF_ERROR?: string;
    __MEASURE?: Measure;
  }
}

function LookAt() {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    camera.lookAt(0, 0.88, 0);
  }, [camera]);
  return null;
}

function MeasureOnce({ rootRef, readyRef, clipRef }: {
  rootRef: React.RefObject<THREE.Group | null>;
  readyRef: { current: boolean };
  clipRef: { current: string | null };
}) {
  const n = useRef(0);
  const done = useRef(false);
  useFrame(() => {
    if (done.current || !readyRef.current || !body) return;
    if (++n.current < 25) return;
    const root = rootRef.current;
    if (!root) return;
    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    const corner = new THREE.Vector3();
    const meshes: MeshBound[] = [];
    const bones: BoneY[] = [];
    let hipsY: number | null = null;
    let headY: number | null = null;
    root.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh && typeof mesh.computeBoundingBox === "function") {
        mesh.computeBoundingBox();
        if (mesh.boundingBox) {
          tmp.copy(mesh.boundingBox);
          const mBox = new THREE.Box3();
          for (const x of [tmp.min.x, tmp.max.x]) {
            for (const y of [tmp.min.y, tmp.max.y]) {
              for (const z of [tmp.min.z, tmp.max.z]) {
                corner.set(x, y, z).applyMatrix4(mesh.matrixWorld);
                box.expandByPoint(corner);
                mBox.expandByPoint(corner);
              }
            }
          }
          if (!mBox.isEmpty()) {
            meshes.push({
              name: mesh.name || mesh.geometry?.name || "(unnamed)",
              minY: mBox.min.y,
              maxY: mBox.max.y,
              heightM: mBox.max.y - mBox.min.y,
            });
          }
        }
      }
      const bone = o as THREE.Bone;
      if (bone.isBone) {
        const name = bone.name.toLowerCase();
        const p = bone.getWorldPosition(new THREE.Vector3());
        bones.push({ name: bone.name, y: p.y });
        if (hipsY === null && name.includes("hips")) hipsY = p.y;
        if (headY === null && name.includes("head") && !name.includes("top")) headY = p.y;
      }
    });
    if (!box.isEmpty()) {
      window.__MEASURE = {
        body: bodyId,
        heightM: box.max.y - box.min.y,
        minY: box.min.y,
        maxY: box.max.y,
        hipsY,
        headY,
        clip: clipRef.current,
        meshes,
        bones: bones.sort((a, b) => b.y - a.y),
        registered: {
          scale: body.scale ?? 1,
          hipsY: body.hipsY,
          walkSpeed: body.walkSpeed,
        },
      };
      done.current = true;
      window.__PROOF_READY = true;
    }
  });
  return null;
}

function Stage() {
  const framesRef = useRef<AgentFrame[]>([]);
  const readyRef = useRef(false);
  const clipRef = useRef<string | null>(null);
  const groupRef = useRef<THREE.Group>(null);

  framesRef.current[0] ??= newWalkerFrame(0, 0, 0);
  if (view === "walk" && body) {
    const f = framesRef.current[0];
    f.state = "walk";
    f.speed = body.walkSpeed;
    f.velocity = [0, body.walkSpeed];
  }

  const camPos: [number, number, number] = view === "side" ? [4.6, 1.25, 0] : [0, 1.25, 4.6];

  return (
    <>
      <color attach="background" args={["#232329"]} />
      <ambientLight intensity={0.95} />
      <hemisphereLight args={["#dfe6ff", "#3a2f28", 0.65]} />
      <directionalLight position={[3, 6, 4]} intensity={2.1} />
      <directionalLight position={[-4, 3, -3]} intensity={0.55} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <circleGeometry args={[9, 48]} />
        <meshStandardMaterial color="#2e2e34" roughness={1} />
      </mesh>
      <gridHelper args={[10, 10, "#4a4a55", "#3a3a42"]} position={[0, 0.002, 0]} />
      <Suspense fallback={null}>
        <group ref={groupRef}>
          {body ? (
            <CastFigure
              framesRef={framesRef}
              index={0}
              baseY={0}
              home={[0, 0, 0]}
              body={body}
              playingClipRef={clipRef}
              renderedReadyRef={readyRef}
            />
          ) : null}
        </group>
      </Suspense>
      <LookAt />
      <MeasureOnce rootRef={groupRef} readyRef={readyRef} clipRef={clipRef} />
      <CameraRig pos={camPos} />
    </>
  );
}

function CameraRig({ pos }: { pos: [number, number, number] }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    camera.position.set(pos[0], pos[1], pos[2]);
    camera.lookAt(0, 0.88, 0);
  }, [camera, pos]);
  return null;
}

if (!body) {
  window.__PROOF_ERROR = `unknown body id "${bodyId}" — known ids: ${Object.keys(BODIES).join(", ")}`;
  document.getElementById("root")!.textContent = window.__PROOF_ERROR;
} else {
  createRoot(document.getElementById("root")!).render(
    <Canvas camera={{ position: [0, 1.25, 4.6], fov: 40 }} gl={{ antialias: true }}>
      <Stage />
    </Canvas>,
  );
}
