// TouchWalkLayer.tsx — Mobile Phase 1: the touch walk MVP's DOM half.
//
// Rendered by GlbWorld INSTEAD of the desktop walk HUD when the touch
// UI is active (coarse pointer on a phone-sized viewport, or
// ?touchUi=1). Everything here writes the abstractions that already
// exist: TouchWalkSource (walkTouch.ts) feeds CityWalker's intent
// seam; the chips call the same InteractController / TeaDoorController
// entry points the E key and the desktop HUD buttons call; the
// consent sheet calls the same SoundDirector consent methods as the
// desktop panel row — PRESENTATION ONLY. The mechanics are the
// shipped ones: audio still arms only inside the Enable tap, and a
// decline is still final for the session (the sheet never re-asks;
// the sound chip is inert after a decline, per the plan).
//
// Layout (MOBILE-PLAN.md §2, walk portrait): exit chip top-left,
// place pill top-center, sound chip top-right (PA announcements come
// from the shell's ShellPaBanner since PR #43 — not duplicated here);
// the interact/door chip in the bottom-center thumb arc; camera pair
// bottom-right; run toggle above it; the floating stick wherever the
// left thumb lands. Every target ≥48 px, everything padded by the
// safe-area insets (world.css .w-touch-*).
import { useEffect, useRef, useState, type RefObject, type TouchEvent as ReactTouchEvent } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import {
  STICK_RADIUS_PX,
  TouchWalkSource,
  classifyTouchGesture,
  doorChipClip,
  interactChipText,
  stickZoneFraction,
} from "./walkTouch";
import { INTERACT_REQUEST_RANGE, type InteractController, type InteractableDef } from "./interactables";
import { PLAYER, type TeaDoorController } from "./teaDoor";
import type { SoundDirector } from "./soundDirector";
import type { WalkClipOverride, WalkFrameInfo } from "./walkOverride";
import type { WalkMode } from "./CityWalker";

/**
 * Touch UI detection: a coarse primary pointer on a phone-sized
 * viewport. A real touchstart on a narrow viewport also qualifies
 * (emulation and odd WebViews report pointer:fine while touching).
 * ?touchUi=1 forces it (house debug-flag pattern).
 */
export function useTouchUi(): boolean {
  const [on, setOn] = useState<boolean>(() => detectTouchUi());
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const update = () => setOn(detectTouchUi());
    mq.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    const onTouch = () => {
      if (window.innerWidth <= 1024) setOn(true);
    };
    window.addEventListener("touchstart", onTouch, { passive: true });
    return () => {
      mq.removeEventListener?.("change", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("touchstart", onTouch);
    };
  }, []);
  return on;
}

function detectTouchUi(): boolean {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get("touchUi") === "1")
    return true;
  return (
    window.matchMedia("(pointer: coarse)").matches && window.innerWidth <= 1024
  );
}

/** The tap picker's signature: client coords → interactable id or null. */
export type TapPicker = (clientX: number, clientY: number) => string | null;

interface Track {
  kind: "stick" | "look";
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  t0: number;
  ox: number;
  oy: number;
}

const clampStickVisual = (dx: number, dy: number): { dx: number; dy: number } => {
  const d = Math.hypot(dx, dy);
  const max = STICK_RADIUS_PX + 14;
  if (d <= max) return { dx, dy };
  return { dx: (dx / d) * max, dy: (dy / d) * max };
};

function SpeakerIcon({ state }: { state: "on" | "off" | "ask" }) {
  // One glyph, three states (ui-rules §3: icon + two visual changes
  // for toggle state — waves present/absent, plus the ask dot).
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z"
        fill="currentColor"
        stroke="none"
      />
      {state === "on" ? (
        <>
          <path d="M15 9.2a4 4 0 0 1 0 5.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M17.4 6.8a7.4 7.4 0 0 1 0 10.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
      ) : null}
      {state === "off" ? (
        <>
          <path d="M15.5 9.5l5 5m0-5l-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
      ) : null}
      {state === "ask" ? (
        <circle cx="17.5" cy="7" r="3" fill="#ffb054" stroke="none" />
      ) : null}
    </svg>
  );
}

export function TouchWalkLayer({
  source,
  frameRef,
  interact,
  door,
  sound,
  channel,
  mode,
  onMode,
  onExit,
  tapPickRef,
}: {
  /** The shared touch intent source CityWalker merges. */
  source: TouchWalkSource;
  /** The walker's latest frame (position source for chip derivations). */
  frameRef: RefObject<WalkFrameInfo | null>;
  interact?: InteractController;
  door?: TeaDoorController;
  sound?: SoundDirector;
  /** The clip channel an interact session fires through (the walk override). */
  channel: WalkClipOverride;
  mode: WalkMode;
  onMode: (m: WalkMode) => void;
  onExit: () => void;
  /** In-Canvas raycast picker for tap-the-prop (TouchTapPicker fills it). */
  tapPickRef: RefObject<TapPicker | null>;
}) {
  const [, setPulse] = useState(0);
  const bump = () => setPulse((p) => p + 1);
  useEffect(() => {
    const id = setInterval(() => setPulse((p) => p + 1), 200);
    return () => clearInterval(id);
  }, []);
  // Leaving walk mode forgets the touch state (no latched run/drift).
  useEffect(() => () => source.reset(), [source]);

  const tracks = useRef(new Map<number, Track>());
  const [stickVis, setStickVis] = useState<{ ox: number; oy: number; dx: number; dy: number } | null>(null);
  const [flash, setFlash] = useState<{ text: string; until: number } | null>(null);

  const showFlash = (text: string) => setFlash({ text, until: Date.now() + 2600 });

  const onTapProp = (clientX: number, clientY: number) => {
    const id = tapPickRef.current?.(clientX, clientY) ?? null;
    if (!id || !interact) return;
    const def = interact.get(id);
    const fr = frameRef.current;
    if (!def || !fr || fr.x === undefined || fr.z === undefined) return;
    const d = Math.hypot(fr.x - def.stand[0], fr.z - def.stand[1]);
    if (d <= INTERACT_REQUEST_RANGE) {
      const r = interact.request(id, PLAYER, channel, { x: fr.x, z: fr.z });
      if (r === "busy") showFlash(`${def.label} — someone is using it`);
      else if (r !== "started" && r !== "already-using") showFlash(`${def.label} — can't reach it from here`);
      bump();
    } else {
      showFlash(`${def.label} — ${d.toFixed(0)} m away`);
    }
  };

  const onTouchStart = (e: ReactTouchEvent) => {
    const w = window.innerWidth;
    const frac = stickZoneFraction(window.innerWidth > window.innerHeight);
    for (const t of Array.from(e.changedTouches)) {
      if (tracks.current.has(t.identifier)) continue;
      const hasStick = [...tracks.current.values()].some((tr) => tr.kind === "stick");
      if (!hasStick && t.clientX < w * frac) {
        tracks.current.set(t.identifier, {
          kind: "stick", startX: t.clientX, startY: t.clientY,
          lastX: t.clientX, lastY: t.clientY, t0: performance.now(),
          ox: t.clientX, oy: t.clientY,
        });
        source.beginStick();
        setStickVis({ ox: t.clientX, oy: t.clientY, dx: 0, dy: 0 });
      } else {
        tracks.current.set(t.identifier, {
          kind: "look", startX: t.clientX, startY: t.clientY,
          lastX: t.clientX, lastY: t.clientY, t0: performance.now(),
          ox: t.clientX, oy: t.clientY,
        });
      }
    }
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      const tr = tracks.current.get(t.identifier);
      if (!tr) continue;
      if (tr.kind === "stick") {
        source.moveStick(t.clientX - tr.ox, t.clientY - tr.oy);
        const v = clampStickVisual(t.clientX - tr.ox, t.clientY - tr.oy);
        setStickVis({ ox: tr.ox, oy: tr.oy, dx: v.dx, dy: v.dy });
      } else {
        source.addLook(t.clientX - tr.lastX, t.clientY - tr.lastY);
      }
      tr.lastX = t.clientX;
      tr.lastY = t.clientY;
    }
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      const tr = tracks.current.get(t.identifier);
      if (!tr) continue;
      tracks.current.delete(t.identifier);
      if (tr.kind === "stick") {
        source.endStick();
        setStickVis(null);
      } else if (
        classifyTouchGesture(t.clientX - tr.startX, t.clientY - tr.startY, performance.now() - tr.t0) === "tap"
      ) {
        // The ambiguity rule's commit point: a clean tap-release on a
        // prop asks for it; anything that dragged was a look.
        onTapProp(t.clientX, t.clientY);
      }
    }
  };

  // ── chip derivations (read at the pulse, like the desktop panel) ──
  const fr = frameRef.current;
  const pos = fr && fr.x !== undefined && fr.z !== undefined ? { x: fr.x, z: fr.z } : null;
  const nearDef: InteractableDef | null =
    interact && pos ? interact.nearest(pos.x, pos.z) : null;
  const session = interact?.sessionOf(PLAYER) ?? null;
  const sessionDef = session ? interact?.get(session.id) ?? null : null;
  const doorClip = door && pos ? doorChipClip(pos.x, pos.z, door.state, door.phase) : null;
  // PA announcements are NOT rendered here: since PR #43 (F1) the
  // shell-level ShellPaBanner shows them in every mode, walking
  // included — a second banner in this layer would double it.
  const consent = sound?.consent ?? "granted";
  const soundState: "on" | "off" | "ask" =
    consent === "unknown" ? "ask" : consent === "granted" && sound && !sound.muted ? "on" : "off";
  const statusText = session
    ? `${sessionDef?.label ?? "Prop"} · ${session.phase === "align" ? "stepping up…" : "using…"}`
    : flash && Date.now() < flash.until
      ? flash.text
      : null;

  return (
    <div className="w-touch-layer">
      <div
        className="w-touch-surface"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      />
      {stickVis ? (
        <div
          className="w-touch-stick"
          style={{ left: stickVis.ox, top: stickVis.oy }}
          aria-hidden="true"
        >
          <div
            className="w-touch-stick-knob"
            style={{ transform: `translate(${stickVis.dx}px, ${stickVis.dy}px)` }}
          />
        </div>
      ) : null}

      <div className="w-touch-top">
        <button type="button" className="w-touch-chip w-touch-exit" onClick={onExit} aria-label="Exit walk">
          ✕
        </button>
        <div className="w-touch-place" aria-hidden="true">Sunstone Bazaar</div>
        <button
          type="button"
          className="w-touch-chip w-touch-sound"
          aria-label={consent === "unknown" ? "Sound permission" : soundState === "on" ? "Sound on — tap to mute" : "Sound off"}
          aria-pressed={soundState === "on"}
          onClick={() => {
            if (!sound) return;
            if (sound.consent === "granted") {
              sound.setMuted(!sound.muted);
              bump();
            }
            // consent unknown: the sheet below is the ask. Declined:
            // final for the session — the chip stays inert by design.
          }}
        >
          <SpeakerIcon state={soundState} />
        </button>
      </div>

      {statusText ? (
        <div className="w-touch-status" role="status">{statusText}</div>
      ) : null}

      <div className="w-touch-right">
        <button
          type="button"
          className={`w-touch-chip w-touch-run${source.runToggle ? " active" : ""}`}
          aria-pressed={source.runToggle}
          aria-label="Run toggle"
          onClick={() => {
            source.runToggle = !source.runToggle;
            bump();
          }}
        >
          Run
        </button>
        <div className="w-touch-cameras" role="group" aria-label="Camera">
          <button
            type="button"
            className={mode === "ride" ? "active" : ""}
            aria-pressed={mode === "ride"}
            onClick={() => onMode("ride")}
          >
            First person
          </button>
          <button
            type="button"
            className={mode === "follow" ? "active" : ""}
            aria-pressed={mode === "follow"}
            onClick={() => onMode("follow")}
          >
            Follow
          </button>
        </div>
      </div>

      <div className="w-touch-actions">
        {doorClip ? (
          <button
            type="button"
            className="w-touch-action"
            onClick={() => {
              door?.request(doorClip);
              bump();
            }}
          >
            🚪 Open the Tea House door
          </button>
        ) : null}
        {nearDef && !session ? (
          <button
            type="button"
            className="w-touch-action primary"
            onClick={() => {
              if (pos && interact) {
                const r = interact.request(nearDef.id, PLAYER, channel, pos);
                if (r === "busy") showFlash(`${nearDef.label} — someone is using it`);
                else if (r === "too-far") showFlash(`${nearDef.label} — can't reach it from here`);
              }
              bump();
            }}
          >
            {interactChipText(nearDef, interact?.isOn(nearDef.id) ?? false)}
          </button>
        ) : null}
      </div>

      {sound && consent === "unknown" ? (
        <div className="w-touch-sheet" role="dialog" aria-label="Sound permission">
          <div className="w-touch-sheet-handle" aria-hidden="true" />
          <div className="w-touch-sheet-title">Hear the verse on this device?</div>
          <p className="w-touch-sheet-body">
            Footsteps, the Tea House radio, and voices — played here, only if you say yes.
          </p>
          <button
            type="button"
            className="w-touch-sheet-enable"
            onClick={() => {
              // Inside this tap's call stack on purpose — the same
              // iOS gesture rule the desktop button follows: the
              // director creates + resumes its AudioContext here.
              sound.grantConsent();
              bump();
            }}
          >
            Enable sound
          </button>
          <button
            type="button"
            className="w-touch-sheet-decline"
            onClick={() => {
              sound.declineConsent();
              bump();
            }}
          >
            Not now
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * In-world highlight for the prop the interact chip would fire on:
 * a pulsing ring at its feet + its action label floating above it
 * (the plan's I1 fix — the affordance anchors to the prop, not to a
 * corner panel). Lives inside the Canvas; reads the same refs the
 * DOM layer reads, per frame, and renders nothing out of range.
 */
export function InteractHighlight({
  interact,
  frameRef,
}: {
  interact?: InteractController;
  frameRef: RefObject<WalkFrameInfo | null>;
}) {
  const group = useRef<THREE.Group>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const [target, setTarget] = useState<InteractableDef | null>(null);
  const targetId = useRef<string | null>(null);
  useFrame(({ clock }) => {
    const fr = frameRef.current;
    const def =
      interact && fr && fr.x !== undefined && fr.z !== undefined
        ? interact.nearest(fr.x, fr.z)
        : null;
    if ((def?.id ?? null) !== targetId.current) {
      targetId.current = def?.id ?? null;
      setTarget(def);
    }
    const t = clock.elapsedTime;
    if (group.current) group.current.scale.setScalar(1 + Math.sin(t * 3.2) * 0.07);
    if (mat.current) mat.current.opacity = 0.55 + Math.sin(t * 3.2) * 0.25;
  });
  if (!target) return null;
  return (
    <group position={[target.pos[0], target.floorY + 0.03, target.pos[2]]}>
      <group ref={group}>
        <mesh rotation-x={-Math.PI / 2}>
          <ringGeometry args={[0.42, 0.52, 40]} />
          <meshBasicMaterial
            ref={mat}
            color={0x6ea8ff}
            transparent
            opacity={0.7}
            depthWrite={false}
          />
        </mesh>
      </group>
      <Html center position={[0, 1.1, 0]} zIndexRange={[7, 0]}>
        <div className="w-touch-tag">
          {interactChipText(target, interact?.isOn(target.id) ?? false)}
        </div>
      </Html>
    </group>
  );
}

/**
 * Tap-the-prop raycast (inside the Canvas): fills `pickRef` with a
 * picker the DOM layer calls when a look-zone touch classifies as a
 * tap. Only the interactable groups (named `interactable:<id>` by
 * interactableMesh.ts) are pickable — the tap answers about props,
 * never about scenery.
 */
export function TouchTapPicker({
  pickRef,
}: {
  pickRef: RefObject<TapPicker | null>;
}) {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    pickRef.current = (clientX: number, clientY: number) => {
      const rect = gl.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      const rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, camera);
      const groups: THREE.Object3D[] = [];
      scene.traverse((o) => {
        if (o.name.startsWith("interactable:")) groups.push(o);
      });
      if (!groups.length) return null;
      const hits = rc.intersectObjects(groups, true);
      if (!hits.length) return null;
      let o: THREE.Object3D | null = hits[0].object;
      while (o && !o.name.startsWith("interactable:")) o = o.parent;
      return o ? o.name.slice("interactable:".length) : null;
    };
    return () => {
      pickRef.current = null;
    };
  }, [scene, camera, gl, pickRef]);
  return null;
}
