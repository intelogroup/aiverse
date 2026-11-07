// ScoutAgent.tsx — the React shell of the Phase 0 agent harness (scout.ts
// owns the pure logic). Mounted by GlbWorld ONLY in City 3 with ?agent=1;
// without the flag nothing here exists and the console is unchanged.
//
// Scout is a cast body (Remy — registered on main, NOT the user's Summer
// bot) driven by the ScoutExecutor through walker.ts's intent seam, the
// same one the keyboard uses. The shell owns: the collision world (same
// construction as CityWalker's), the follow camera (which also keeps
// interiors streamed around Scout — InteriorStreamer keys on the camera),
// the first-person look capture, and the window.__scout promise API the
// runner drives:
//
//   __scout.ready()    -> boolean (world + data + spawn complete)
//   __scout.snapshot() -> blackboard snapshot (see scoutSnapshot below)
//   __scout.look()     -> { image: PNG data URL, scene: oracle objects }
//   __scout.act(action)-> outcome + fresh snapshot
//   __scout.places() / __scout.sittables() -> the registered world data
//
// Look capture: a dedicated render target + a camera posed at Scout's head
// bone (CastFigure's headPoseRef stream, the vision probe's anchor), NOT a
// borrow of the follow camera's frame — the probe's drawImage readback
// needs preserveDrawingBuffer (off outside embody) and would return the
// spectator view, not Scout's eyes. Same head-pose source, exact framing.
//
// `say` is log-only in Phase 0: the console has no speech-bubble/caption
// mechanism to reuse cheaply, and inventing one is not harness work. The
// runner's trace carries the text; Scout's utterances land in the console
// log with a [scout-say] prefix.
//
// Simulation clock: the executor ticks on a 100 ms interval, NOT on
// render frames. Measured on this machine, headless SwiftShader renders
// the full city at ~1 fps — coupling the sim to rAF made Scout live at
// 0.03x real time (a 2 s wait took 168 s of wall clock). The walker step
// is cheap; rendering is not. Agent mode therefore also runs the Canvas
// frameloop="demand" with shadows off (GlbWorld): ScoutAgent pumps
// frames while the world loads, then invalidates on a 1 s heartbeat —
// enough for interior streaming (140 m load radius) while the sim keeps
// the thread. Look captures render their own target and do not depend
// on the canvas loop at all. The figure/camera update per rendered
// frame from the executor's state, so the spectator view steps at the
// heartbeat while agent time (snapshot t, action budgets) tracks wall
// time.

import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useRef } from "react";
import * as THREE from "three";
import { CastFigure } from "./CastFigure";
import { BODY_REMY } from "./bodies";
import { EYE_FORWARD, HEAD_HEIGHT, damp } from "./cameraRig";
import type { City3Room } from "./city3";
import { ClipTestState } from "./clips";
import type { AgentFrame } from "./locomotion";
import {
  ScoutExecutor,
  districtAt,
  nearestPlace,
  oracleScene,
  roomAt,
  type OracleObject,
  type ScoutAction,
  type ScoutDistrict,
  type ScoutOutcome,
  type ScoutPlace,
  type Sittable,
} from "./scout";
import type { WalkColliders } from "./walkColliders";
import { newWalkerFrame, useWalkWorld, writeWalkerFrame } from "./walkerBody";
import { clipFor, findSpawn, makeWalker, type WalkerState } from "./walker";

export interface ScoutSnapshot {
  t: number;
  pos: [number, number, number];
  headingDeg: number;
  bodyHeadingDeg: number;
  speed: number;
  groundY: number;
  district: string | null;
  nearestPlace: { id: string; name: string; kind: string; dist: number } | null;
  insideRoom: string | null;
  posture: string;
  clip: string | null;
  busy: boolean;
  currentAction: string | null;
  /** Other movers within 10 m. Run 1 has no other movers in City 3. */
  movers: never[];
  looksUsed: number;
  finished: boolean;
  worldKind: string;
}

export interface ScoutApi {
  ready: () => boolean;
  snapshot: () => ScoutSnapshot | null;
  look: () => Promise<{ image: string | null; scene: OracleObject[] }>;
  act: (action: ScoutAction) => Promise<(ScoutOutcome & { snapshot: ScoutSnapshot | null }) | null>;
  places: () => ScoutPlace[];
  sittables: () => Sittable[];
}

const LOOK_W = 512;
const LOOK_H = 288;
const deg = (r: number) => Math.round(((r * 180) / Math.PI) * 10) / 10;

export function ScoutAgent({
  getMeshes,
  walk,
  rooms,
}: {
  getMeshes: () => THREE.Mesh[];
  walk?: WalkColliders;
  rooms: City3Room[];
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update?: () => void } | null;

  const world = useWalkWorld(getMeshes, walk);

  const data = useRef<{ places: ScoutPlace[]; sittables: Sittable[]; districts: ScoutDistrict[] } | null>(null);
  const clips = useRef<ClipTestState | null>(null);
  if (clips.current === null) clips.current = new ClipTestState();
  const exec = useRef<ScoutExecutor | null>(null);
  const state = useRef<WalkerState | null>(null);
  const frames = useRef<AgentFrame[]>([newWalkerFrame()]);
  const figure = useRef<THREE.Group>(null);
  const headPose = useRef<[number, number, number] | null>(null);
  const looksUsed = useRef(0);
  const camPos = useRef<THREE.Vector3 | null>(null);
  const lookRig = useRef<{ rt: THREE.WebGLRenderTarget; cam: THREE.PerspectiveCamera; px: Uint8Array } | null>(null);

  // Load the harness's world data (generated assets; see scout.ts header).
  useEffect(() => {
    let live = true;
    const get = async <T,>(url: string): Promise<T> => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return (await r.json()) as T;
    };
    void (async () => {
      try {
        const [places, sittables, districtsDoc] = await Promise.all([
          get<ScoutPlace[]>("/assets/city3-places.json"),
          get<Sittable[]>("/assets/city3-anchors.json"),
          get<{ districts: ScoutDistrict[] }>("/assets/districts.json"),
        ]);
        if (!live) return;
        data.current = { places, sittables, districts: districtsDoc.districts };
        exec.current = new ScoutExecutor({
          places,
          sittables,
          clips: clips.current!,
          hipsY: BODY_REMY.hipsY,
        });
      } catch (e) {
        console.error("[scout] world data failed to load", e);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Leave the wide camera exactly where it was (CityWalker's courtesy).
  useEffect(() => {
    const p = camera.position.clone();
    const t = controls?.target.clone() ?? null;
    return () => {
      camera.position.copy(p);
      if (t && controls) {
        controls.target.copy(t);
        controls.update?.();
      }
    };
  }, [camera, controls]);

  const snapshot = (): ScoutSnapshot | null => {
    const s = state.current;
    const ex = exec.current;
    const d = data.current;
    if (!s || !ex || !d) return null;
    const np = nearestPlace(d.places, s.x, s.z);
    const room = roomAt(rooms, s.x, s.z);
    const dist = districtAt(d.districts, s.x, s.z);
    return {
      t: Math.round(ex.t * 100) / 100,
      pos: [Math.round(s.x * 100) / 100, Math.round(s.y * 100) / 100, Math.round(s.z * 100) / 100],
      headingDeg: deg(s.heading),
      bodyHeadingDeg: deg(s.body),
      speed: Math.round(s.speed * 100) / 100,
      groundY: Math.round(s.y * 100) / 100,
      district: dist?.name ?? null,
      nearestPlace: np ? { id: np.place.id, name: np.place.name, kind: np.place.kind, dist: Math.round(np.dist * 100) / 100 } : null,
      insideRoom: room?.name ?? null,
      posture: ex.posture,
      clip: clips.current!.current ?? clipFor(s.speed),
      busy: ex.busy,
      currentAction: ex.currentAction?.type ?? null,
      movers: [],
      looksUsed: looksUsed.current,
      finished: ex.finished,
      worldKind: world.kind(),
    };
  };

  const captureLook = (): string | null => {
    const s = state.current;
    if (!s) return null;
    if (!lookRig.current) {
      lookRig.current = {
        rt: new THREE.WebGLRenderTarget(LOOK_W, LOOK_H),
        cam: new THREE.PerspectiveCamera(55, LOOK_W / LOOK_H, 0.1, 500),
        px: new Uint8Array(LOOK_W * LOOK_H * 4),
      };
    }
    const { rt, cam, px } = lookRig.current;
    const hp = headPose.current;
    const hx = hp ? hp[0] : s.x;
    const hy = hp ? hp[1] : s.y + HEAD_HEIGHT;
    const hz = hp ? hp[2] : s.z;
    const sn = Math.sin(s.body);
    const cs = Math.cos(s.body);
    cam.position.set(hx + sn * EYE_FORWARD, hy, hz + cs * EYE_FORWARD);
    cam.lookAt(cam.position.x + sn * 5, cam.position.y, cam.position.z + cs * 5);
    cam.updateMatrixWorld();
    const fig = figure.current;
    const wasVisible = fig ? fig.visible : true;
    if (fig) fig.visible = false;
    try {
      gl.setRenderTarget(rt);
      gl.render(scene, cam);
      gl.readRenderTargetPixels(rt, 0, 0, LOOK_W, LOOK_H, px);
    } finally {
      gl.setRenderTarget(null);
      if (fig) fig.visible = wasVisible;
    }
    const canvas = document.createElement("canvas");
    canvas.width = LOOK_W;
    canvas.height = LOOK_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const img = ctx.createImageData(LOOK_W, LOOK_H);
    // WebGL rows are bottom-up; flip into image order.
    const row = LOOK_W * 4;
    for (let y = 0; y < LOOK_H; y++) {
      img.data.set(px.subarray((LOOK_H - 1 - y) * row, (LOOK_H - y) * row), y * row);
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png");
  };

  // window.__scout — the runner's door in.
  useEffect(() => {
    const api: ScoutApi = {
      ready: () => state.current !== null && exec.current !== null,
      snapshot: () => snapshot(),
      look: async () => {
        looksUsed.current += 1;
        const s = state.current;
        const d = data.current;
        const sceneObjs =
          s && d ? oracleScene(d.places, rooms, { x: s.x, z: s.z, heading: s.body }) : [];
        return { image: captureLook(), scene: sceneObjs };
      },
      act: async (action) => {
        const ex = exec.current;
        const s = state.current;
        if (!ex || !s) return null;
        if (action.type === "say") {
          console.info(`[scout-say] ${action.text}`);
        }
        const outcome = await ex.submit(action, s);
        return { ...outcome, snapshot: snapshot() };
      },
      places: () => data.current?.places ?? [],
      sittables: () => data.current?.sittables ?? [],
    };
    const w = window as unknown as Record<string, unknown>;
    w.__scout = api;
    return () => {
      delete w.__scout;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, world]);

  // The sim driver: spawn + executor ticks on a wall-clock interval (see
  // the header note). Substeps keep walker.step at its tuned dt. The
  // Canvas runs frameloop="demand" in agent mode: this driver pumps
  // frames fast while the world loads, then settles to a 1 s heartbeat —
  // enough to keep InteriorStreamer planning around Scout (its load
  // radius is 140 m) without letting SwiftShader's ~0.5 s frames starve
  // the sim.
  useEffect(() => {
    let last = performance.now();
    let ticks = 0;
    const id = window.setInterval(() => {
      ticks += 1;
      const ready = state.current !== null && exec.current !== null;
      if (!ready || ticks % 10 === 0) invalidate();
      const ex = exec.current;
      if (!ex || world.kind() === "pending") return;
      let s = state.current;
      if (!s) {
        const sp = findSpawn(world);
        if (!sp) return;
        s = state.current = makeWalker(sp.x, sp.y, sp.z, 0);
      }
      const now = performance.now();
      let dt = Math.min((now - last) / 1000, 0.3);
      last = now;
      while (dt > 0) {
        const stepDt = Math.min(dt, 1 / 30);
        ex.tick(stepDt, s, world);
        dt -= stepDt;
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [world, invalidate]);

  useFrame(() => {
    const ex = exec.current;
    const s = state.current;
    if (!ex || !s) return;

    // Figure transform: the walker state, or the executor's seat override.
    const ov = ex.frameOverride();
    const f = writeWalkerFrame(frames.current[0], s, ov);
    const fx = f.position[0];
    const fz = f.position[1];
    if (figure.current) figure.current.position.y = ov ? ov.y + ov.drop : s.y;

    // Streaming + theme follow Scout; the follow camera keeps interiors
    // resident around it (InteriorStreamer plans off the camera).
    controls?.target.set(fx, (ov ? ov.y : s.y) + 1, fz);
    const dt = 1 / 30; // nominal frame dt for the camera damp (cosmetic)
    if (!camPos.current) camPos.current = camera.position.clone();
    const sn = Math.sin(s.heading);
    const cs = Math.cos(s.heading);
    const baseY = ov ? ov.y : s.y;
    camPos.current.set(
      damp(camPos.current.x, fx - sn * 6.5, 8, dt),
      damp(camPos.current.y, baseY + 3.1, 8, dt),
      damp(camPos.current.z, fz - cs * 6.5, 8, dt),
    );
    camera.position.copy(camPos.current);
    camera.lookAt(fx, baseY + 1.1, fz);
  }, -1);

  return (
    <group ref={figure}>
      <Suspense fallback={null}>
        <CastFigure
          framesRef={frames}
          index={0}
          baseY={0}
          home={[0, 0, 0]}
          label="Scout"
          body={BODY_REMY}
          clipTester={clips.current ?? undefined}
          headPoseRef={headPose}
        />
      </Suspense>
    </group>
  );
}
