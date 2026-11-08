import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as THREE from "three";
import type { AgentFrame } from "./locomotion";
import "./characterHud.css";

/** First character HUD: a local guide, with no network conversation implied. */
export function CharacterHud({ framesRef, home, visitNonce = 0, activity, children }: {
  framesRef: RefObject<AgentFrame[]>;
  home: [number, number, number];
  visitNonce?: number;
  activity: () => string;
  children: (activate: () => void) => ReactNode;
}) {
  const { camera, controls, gl } = useThree();
  const [open, setOpen] = useState(false);
  const [near, setNear] = useState(false);
  const [occluded, setOccluded] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  const [status, setStatus] = useState("At the stall");
  const [topic, setTopic] = useState<"welcome" | "bazaar" | "fountain" | null>(null);
  const anchor = useRef<THREE.Group>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const vectors = useRef({ at: new THREE.Vector3(), world: new THREE.Vector3(), right: new THREE.Vector3(), toward: new THREE.Vector3() });
  const clock = useRef(0);
  const activate = () => { setTopic(null); setOpen(true); };
  const close = () => { returnFocus.current = true; setOpen(false); };

  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const changed = () => setMobile(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    if (!visitNonce) return;
    const orbit = controls as unknown as { target: THREE.Vector3; update: () => void } | null;
    if (!orbit) return;
    orbit.target.set(home[0], home[1] + 1.2, home[2]);
    camera.position.set(home[0] + 2.2, home[1] + 2.6, home[2] - 5.2);
    orbit.update();
    setTopic(null);
    setOpen(true);
  }, [visitNonce, camera, controls, home[0], home[1], home[2]]);

  useEffect(() => {
    if (!open) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      returnFocus.current = true;
      setOpen(false);
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [open]);

  useEffect(() => {
    if (open && near && !occluded) closeButton.current?.focus({ preventScroll: true });
  }, [open, near, occluded, mobile]);

  useFrame((_, dt) => {
    const group = anchor.current;
    if (!group || !group.parent) return;
    const f = framesRef.current[0];
    const v = vectors.current;
    v.at.set(f?.position[0] ?? home[0], home[1] + 1.2, f?.position[1] ?? home[2]);
    v.world.copy(v.at);
    group.parent.localToWorld(v.world);
    v.toward.copy(camera.position).sub(v.world); v.toward.y = 0; v.toward.normalize();
    v.right.set(1, 0, 0).applyQuaternion(camera.quaternion); v.right.y = 0; v.right.normalize();
    // Camera-facing side offset keeps the card off the face; no skeleton bob or heading rotation.
    v.world.addScaledVector(v.toward, .65).addScaledVector(v.right, open && !mobile ? 1.25 : .0);
    group.position.copy(group.parent.worldToLocal(v.world));
    if (!open) group.position.y += 1.05;
    clock.current += dt;
    if (clock.current < .15) return;
    clock.current = 0;
    group.getWorldPosition(v.world);
    const inRange = camera.position.distanceTo(v.world) < 18;
    setNear(inRange);
    if (!inRange) setOpen(false);
    const next = activity();
    setStatus(old => old === next ? old : next);
  });

  const card = <section role="dialog" aria-label="The Mage character panel" aria-modal="false"
    className={`w-character-card${mobile ? " w-character-card-mobile" : ""}`} data-world-input="dialog"
    onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}
    onKeyDown={e => e.stopPropagation()}>
    <header>
      <span className="w-character-eyebrow">CITY 3 / SUNSTONE BAZAAR</span>
      <button ref={node => {
        closeButton.current = node;
        // This ref runs in React DOM after the dialog is committed, across Html's renderer boundary.
        if (node && document.pointerLockElement === gl.domElement) document.exitPointerLock();
      }} autoFocus type="button" className="w-character-close" aria-label="Close character panel" onClick={close}>×</button>
    </header>
    <div className="w-character-identity"><span className="w-character-emblem" aria-hidden="true">✦</span><div><h2>The Mage</h2><p>Bazaar guide</p></div></div>
    <p className="w-character-status"><span aria-hidden="true" />{status}</p>
    {topic ? <div className="w-character-response" aria-live="polite">
      {topic === "welcome" ? "Welcome to Sunstone Bazaar. Take a look around the stalls, or rest beside the fountain." :
        topic === "bazaar" ? "The market tables hold fruit, bread, pottery and woven baskets. Follow the stalls around the plaza to explore." :
        "The fountain is at the heart of the plaza. Look for its water jets and the herb pots around the outside."}
    </div> : <p className="w-character-intro">A familiar face among the market stalls.<br />Stop for a moment and say hello.</p>}
    {topic ? <div className="w-character-topics" aria-label="Guide topics">
      <button type="button" onClick={() => setTopic("bazaar")}>The bazaar ↗</button>
      <button type="button" onClick={() => setTopic("fountain")}>The fountain ↗</button>
    </div> : <button type="button" className="w-character-talk" onClick={() => setTopic("welcome")}>Talk <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 12 12 4M4 4h8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
    <footer>LOCAL GUIDE<span>ESC TO CLOSE</span></footer>
  </section>;

  return <>
    {children(activate)}
    <group ref={anchor} name="character-hud:mage">
      <Html center occlude onOcclude={setOccluded} zIndexRange={[45, 35]}
        style={{ visibility: near && !occluded ? "visible" : "hidden", pointerEvents: near && !occluded ? "auto" : "none" }}>
        {open ? (!mobile ? card : <>
          <span aria-hidden="true" className="w-character-tether" />
          {near && !occluded ? createPortal(card, document.body) : null}
        </>) :
          <button ref={node => { trigger.current = node; if (node && returnFocus.current) { returnFocus.current = false; node.focus({ preventScroll: true }); } }} type="button" className="w-character-trigger" aria-label="Meet the Mage" aria-expanded={open}
            onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); activate(); }}>✦ <span>The Mage</span></button>}
      </Html>
    </group>
  </>;
}
