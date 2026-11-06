import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CastFigure } from "./CastFigure";
import { BODY_SUMMER } from "./bodies";
import { createBvhWorld } from "./bvhWorld";
import { createCapsuleWorld } from "./capsuleWorld";
import type { WalkColliders } from "./walkColliders";
import { COLLIDE_FLOOR, resolveCamera } from "./cameraCollision";
import { DAMP_FOV, DAMP_POS_FOLLOW, FOV_RIDE, FOV_WIDE, EYE_FORWARD, FOLLOW_BACK, FOLLOW_LOOK_UP, FOLLOW_UP, HEAD_HEIGHT, RIDE_LOOK_AHEAD, damp } from "./cameraRig";
import type { AgentFrame } from "./locomotion";
import { clipFor, findSpawn, makeWalker, step, type World, type WalkInput } from "./walker";

// CityWalker — the user-driven bot in City 3 (?world=city3&walk=1). A thin adapter around walker.ts:
//   keyboard/mouse -> abstract intent {forward, strafe, turn, run, look} -> walker.step(world = BVH raycasts)
//   -> AgentFrame for the existing "summer" CastFigure (walk/idle clip from speed) -> ride/follow camera.
// An agent would feed the same `step` with its own intents instead of the keys read here.

export type WalkMode = "ride" | "follow";

const MOUSE_SENS = 0.0022;
const PITCH_MAX = 1.25;
const WALK_NEAR = 0.1;

type Held = { fwd: boolean; back: boolean; left: boolean; right: boolean; tl: boolean; tr: boolean; run: boolean };
const noKeys = (): Held => ({ fwd: false, back: false, left: false, right: false, tl: false, tr: false, run: false });

/** Keys -> intent. The only place the keyboard exists. */
export function intentFromKeys(k: Held, look: number): WalkInput {
  return {
    forward: (k.fwd ? 1 : 0) - (k.back ? 1 : 0),
    strafe: (k.right ? 1 : 0) - (k.left ? 1 : 0),
    turn: (k.tr ? 1 : 0) - (k.tl ? 1 : 0),
    run: k.run,
    look,
  };
}

export function CityWalker({
  mode,
  onMode,
  onExit,
  getMeshes,
  walk,
}: {
  mode: WalkMode;
  onMode: (m: WalkMode) => void;
  onExit: () => void;
  /** Visual/camera meshes: the follow-cam wall ray, and the raycast fallback world if the collision GLB failed to load. */
  getMeshes: () => THREE.Mesh[];
  /** The walker's collision list (capsule world). Without it (tests, older hosts) the raycast world over `getMeshes` is used. */
  walk?: WalkColliders;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update?: () => void } | null;
  // Capsule shapecast over the collision GLBs; the old raycast world over the visual meshes only if collision failed to load.
  const world = useMemo<World & { kind: () => "capsule" | "raycast" | "pending" }>(() => {
    const ray = createBvhWorld(getMeshes);
    if (!walk) return Object.assign(ray, { kind: () => "raycast" as const });
    const cap = createCapsuleWorld(walk.list);
    const pick = (): World => (walk.status === "failed" ? ray : cap);
    return {
      groundY: (x, z, fromY) => pick().groundY(x, z, fromY),
      blocked: (a, b, r) => pick().blocked(a, b, r),
      kind: () => (walk.status === "ready" ? "capsule" : walk.status === "failed" ? "raycast" : "pending"),
    };
  }, [getMeshes, walk]);

  const state = useRef<ReturnType<typeof makeWalker> | null>(null);
  const pitch = useRef(0);
  const keys = useRef<Held>(noKeys());
  const lookAcc = useRef(0);
  const frames = useRef<AgentFrame[]>([
    { position: [0, 0], velocity: [0, 0], speed: 0, heading: 0, state: "idle", targetsReached: 0 },
  ]);
  const figure = useRef<THREE.Group>(null);
  const rig = useRef<{ mode: WalkMode; y: number; pos: THREE.Vector3; look: THREE.Vector3; shown: number } | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const cbs = useRef({ onMode, onExit });
  cbs.current = { onMode, onExit };

  // Leave the wide camera exactly where it was.
  useEffect(() => {
    const p = camera.position.clone();
    const { fov, near } = camera;
    const t = controls?.target.clone() ?? null;
    return () => {
      camera.position.copy(p);
      camera.fov = fov;
      camera.near = near;
      camera.updateProjectionMatrix();
      if (t && controls) {
        controls.target.copy(t);
        controls.update?.();
      }
    };
  }, [camera, controls]);

  // Keyboard + mouse-look (pointer lock). Esc / losing the lock leaves walk mode.
  useEffect(() => {
    const canvas = gl.domElement;
    const typing = (e: Event) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    };
    const set = (code: string, down: boolean): boolean => {
      const k = keys.current;
      switch (code) {
        case "KeyW": case "ArrowUp": k.fwd = down; return true;
        case "KeyS": case "ArrowDown": k.back = down; return true;
        case "KeyA": k.left = down; return true;
        case "KeyD": k.right = down; return true;
        case "ArrowLeft": k.tl = down; return true;
        case "ArrowRight": k.tr = down; return true;
        case "ShiftLeft": case "ShiftRight": k.run = down; return true;
      }
      return false;
    };
    const onDown = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.code === "Escape") { cbs.current.onExit(); return; }
      if (e.code === "KeyV" && !e.repeat) { cbs.current.onMode(modeRef.current === "ride" ? "follow" : "ride"); return; }
      if (set(e.code, true)) e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => { set(e.code, false); };
    const onBlur = () => { keys.current = noKeys(); };
    let lockedOnce = false;
    const locked = () => document.pointerLockElement === canvas;
    const onMove = (e: MouseEvent) => {
      if (!locked()) return;
      lookAcc.current += e.movementX * MOUSE_SENS;
      pitch.current = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, pitch.current - e.movementY * MOUSE_SENS));
    };
    const onPointerDown = () => {
      if (locked()) return;
      try { (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch { /* denied: keys still work */ }
    };
    const onLockChange = () => {
      if (locked()) lockedOnce = true;
      else if (lockedOnce) cbs.current.onExit(); // Esc while captured releases the lock: that is "leave"
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("pointerlockchange", onLockChange);
    canvas.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("pointerlockchange", onLockChange);
      canvas.removeEventListener("pointerdown", onPointerDown);
      if (locked()) { lockedOnce = false; document.exitPointerLock(); }
    };
  }, [gl]);

  // ?walkDebug=1: drive/inspect from tests.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("walkDebug")) return;
    const w = window as unknown as Record<string, unknown>;
    w.__walk = {
      state: () => (state.current ? { ...state.current, pitch: pitch.current, mode: modeRef.current } : null),
      teleport: (x: number, z: number, heading?: number, fromY = 20) => {
        const g = world.groundY(x, z, fromY);
        if (g === null) return false;
        state.current = makeWalker(x, g, z, heading ?? state.current?.heading ?? 0);
        rig.current = null;
        return true;
      },
      pitch: (p: number) => { pitch.current = p; },
      ground: (x: number, z: number, fromY: number) => world.groundY(x, z, fromY),
      worldKind: () => world.kind(),
      /** Place the walker exactly (no ground lookup). */
      put: (x: number, y: number, z: number, heading = 0) => { state.current = makeWalker(x, y, z, heading); rig.current = null; },
      /**
       * Fixed-dt simulation without rendering: inputs = [forward, strafe, turn, run(0/1), dt][]; returns the trace
       * [x, y, z, speed] per input (flat). The same `step` the frame loop calls.
       */
      script: (inputs: number[][]) => {
        const s = state.current;
        if (!s) return null;
        const out = new Array<number>(inputs.length * 4);
        inputs.forEach(([f, r, t, run, dt], i) => {
          step(s, { forward: f, strafe: r, turn: t, run: run > 0 }, dt, world);
          out[i * 4] = s.x; out[i * 4 + 1] = s.y; out[i * 4 + 2] = s.z; out[i * 4 + 3] = s.speed;
        });
        return out;
      },
    };
    return () => { delete w.__walk; };
  }, [world]);

  useFrame((_, delta) => {
    const meshes = getMeshes();
    if (!meshes.length || world.kind() === "pending") return; // resident world / collision still loading
    let s = state.current;
    if (!s) {
      const sp = findSpawn(world);
      if (!sp) return;
      s = state.current = makeWalker(sp.x, sp.y, sp.z, 0);
    }
    const look = lookAcc.current;
    lookAcc.current = 0;
    step(s, intentFromKeys(keys.current, look), delta, world);

    // Frame for CastFigure (clip from speed) and the figure group's height.
    const f = frames.current[0];
    f.position[0] = s.x; f.position[1] = s.z;
    f.velocity[0] = s.vx; f.velocity[1] = s.vz;
    // Figure faces the BODY heading (turns toward travel; backpedal reverses Walk); cameras below use the VIEW heading.
    f.speed = s.speed; f.heading = s.body; f.state = clipFor(s.speed);
    (f.gait ??= { reverse: false }).reverse = s.backward;
    if (figure.current) figure.current.position.y = s.y;

    // Streaming/theme follow the bot, not the (parked) orbit camera.
    controls?.target.set(s.x, s.y + 1, s.z);

    // ---- camera ----
    const dt = Math.min(delta, 0.05);
    let r = rig.current;
    const m = modeRef.current;
    if (!r || r.mode !== m) {
      r = rig.current = { mode: m, y: s.y, pos: new THREE.Vector3(), look: new THREE.Vector3(), shown: FOLLOW_BACK };
      r.pos.copy(camera.position);
      if (camera.near !== WALK_NEAR) { camera.near = WALK_NEAR; camera.updateProjectionMatrix(); }
    }
    const sn = Math.sin(s.heading), cs = Math.cos(s.heading);
    if (m === "ride") {
      r.y = damp(r.y, s.y, 14, dt); // stairs ease instead of popping
      const cp = Math.cos(pitch.current), sp = Math.sin(pitch.current);
      camera.position.set(s.x + sn * EYE_FORWARD, r.y + HEAD_HEIGHT, s.z + cs * EYE_FORWARD);
      camera.lookAt(
        camera.position.x + sn * cp * RIDE_LOOK_AHEAD,
        camera.position.y + sp * RIDE_LOOK_AHEAD,
        camera.position.z + cs * cp * RIDE_LOOK_AHEAD,
      );
    } else {
      r.y = damp(r.y, s.y, DAMP_POS_FOLLOW, dt);
      const tx = s.x, ty = r.y + FOLLOW_LOOK_UP, tz = s.z;
      // Camera behind/above; pitch (mouse up) lowers it, down raises it.
      const want: [number, number, number] = [s.x - sn * FOLLOW_BACK, r.y + FOLLOW_UP - pitch.current * 1.6, s.z - cs * FOLLOW_BACK];
      // Keep it out of walls (CameraCollider is wide-mode only): one ray from the chest to the wanted spot.
      const from = new THREE.Vector3(tx, ty, tz);
      const d = new THREE.Vector3(want[0] - tx, want[1] - ty, want[2] - tz);
      const len = d.length();
      d.multiplyScalar(1 / len);
      const rc = Object.assign(new THREE.Raycaster(from, d, 0, len), { firstHitOnly: true });
      const hit = rc.intersectObjects(meshes, false)[0];
      const allowed = resolveCamera([tx, ty, tz], want, hit ? hit.distance : null, 0.25, COLLIDE_FLOOR);
      r.pos.set(
        damp(r.pos.x, allowed[0], 10, dt),
        damp(r.pos.y, allowed[1], 10, dt),
        damp(r.pos.z, allowed[2], 10, dt),
      );
      camera.position.copy(r.pos);
      r.look.set(tx, ty, tz);
      camera.lookAt(r.look);
    }
    const targetFov = m === "ride" ? FOV_RIDE : FOV_WIDE;
    const fov = damp(camera.fov, targetFov, DAMP_FOV, dt);
    if (Math.abs(fov - camera.fov) > 0.001) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }, -1);

  const s0 = state.current;
  return (
    <group ref={figure}>
      <Suspense fallback={null}>
        <CastFigure
          framesRef={frames}
          index={0}
          baseY={0}
          home={[s0?.x ?? 0, 0, s0?.z ?? 0]}
          body={BODY_SUMMER}
          hidden={mode === "ride"}
        />
      </Suspense>
    </group>
  );
}
