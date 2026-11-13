import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

// In-canvas name tag + speech bubble above an agent. Drawn to canvas textures on sprites (not DOM) so the
// VerseRecorder canvas capture, and later the clip maker, see them.
export const SPEECH_MAX_CHARS = 140;
export const SPEECH_SHOW_S = 5;
const FADE_S = 0.6;

/** Moderation floor before any speech is shown: strip control chars, collapse space, cap length. Empty means do not show. */
export function cleanSpeech(text: unknown): string {
  if (typeof text !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > SPEECH_MAX_CHARS ? `${t.slice(0, SPEECH_MAX_CHARS - 1)}…` : t;
}

/** Greedy word wrap by measured width; a word wider than the line is hard-split. */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    let w = word;
    while (measure(w) > maxWidth && w.length > 1) {
      let n = w.length - 1;
      while (n > 1 && measure(w.slice(0, n)) > maxWidth) n--;
      if (line) { lines.push(line); line = ""; }
      lines.push(w.slice(0, n));
      w = w.slice(n);
    }
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next) > maxWidth) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Bubble opacity: full while shown, fades over the last FADE_S, zero after. */
export function bubbleOpacity(age: number): number {
  if (age < 0 || age >= SPEECH_SHOW_S) return 0;
  return Math.min(1, (SPEECH_SHOW_S - age) / FADE_S);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function drawName(name: string): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = 512; c.height = 96;
  const g = c.getContext("2d")!;
  g.font = "600 44px system-ui, sans-serif";
  const w = Math.min(496, g.measureText(name).width + 48);
  g.fillStyle = "rgba(10,14,26,0.72)"; roundRect(g, (512 - w) / 2, 12, w, 72, 36); g.fill();
  g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(name, 256, 49, 470);
  return c;
}

function drawBubble(text: string): { canvas: HTMLCanvasElement; lines: number } {
  const W = 640, LH = 46, PAD = 28;
  const c = document.createElement("canvas"); c.width = W;
  const g0 = c.getContext("2d")!;
  g0.font = "500 38px system-ui, sans-serif";
  const lines = wrapLines(text, W - PAD * 2 - 8, s => g0.measureText(s).width);
  c.height = lines.length * LH + PAD * 2 + 26; // +26: tail
  const g = c.getContext("2d")!;
  g.font = "500 38px system-ui, sans-serif";
  const bh = lines.length * LH + PAD * 2;
  g.fillStyle = "rgba(255,255,255,0.96)"; roundRect(g, 4, 4, W - 8, bh - 8, 28); g.fill();
  g.beginPath(); g.moveTo(W / 2 - 18, bh - 6); g.lineTo(W / 2, bh + 20); g.lineTo(W / 2 + 18, bh - 6); g.closePath(); g.fill();
  g.fillStyle = "#101522"; g.textBaseline = "top";
  lines.forEach((l, i) => g.fillText(l, PAD + 4, PAD + i * LH));
  return { canvas: c, lines: lines.length };
}

export type SpeechState = { text: string; at: number } | null;

/** `getPose` gives the head-base world position each frame; `speech.at` is clock seconds (state set by the owner). */
export function AgentLabel({ name, getPose, speech, clock }: {
  name: string;
  getPose: () => { x: number; y: number; z: number } | null;
  speech: { current: SpeechState };
  clock: () => number;
}) {
  const group = useRef<THREE.Group>(null);
  const nameSprite = useRef<THREE.Sprite>(null);
  const bubbleSprite = useRef<THREE.Sprite>(null);
  const shown = useRef("");
  const nameTex = useMemo(() => new THREE.CanvasTexture(drawName(name)), [name]);
  const bubbleTex = useRef<THREE.CanvasTexture | null>(null);
  useEffect(() => () => { nameTex.dispose(); bubbleTex.current?.dispose(); }, [nameTex]);
  useFrame(() => {
    const p = getPose(), g = group.current, b = bubbleSprite.current;
    if (!p || !g || !b) return;
    g.position.set(p.x, p.y + 2.05, p.z);
    const sp = speech.current;
    const op = sp ? bubbleOpacity(clock() - sp.at) : 0;
    if (sp && op > 0 && shown.current !== sp.text) {
      const { canvas, lines } = drawBubble(sp.text);
      bubbleTex.current?.dispose();
      const tex = (bubbleTex.current = new THREE.CanvasTexture(canvas));
      (b.material as THREE.SpriteMaterial).map = tex; (b.material as THREE.SpriteMaterial).needsUpdate = true;
      const h = canvas.height / 640 * 2.2; // world height at width 2.2, rescaled just below
      b.scale.set(3, h * 3 / 2.2, 1);
      b.center.set(0.5, 0); b.position.set(0, 0.42, 0);
      shown.current = sp.text; void lines;
    }
    (b.material as THREE.SpriteMaterial).opacity = op;
    b.visible = op > 0;
    if (op === 0) shown.current = "";
  });
  return (
    <group ref={group}>
      <sprite ref={nameSprite} scale={[1.8, 0.338, 1]} renderOrder={20}>
        <spriteMaterial map={nameTex} transparent depthWrite={false} toneMapped={false} />
      </sprite>
      <sprite ref={bubbleSprite} visible={false} renderOrder={21}>
        <spriteMaterial transparent depthWrite={false} toneMapped={false} opacity={0} />
      </sprite>
    </group>
  );
}

/** Soft additive ring on the ground under an agent: the equipped cosmetic from egg finds. */
export function AgentAura({ getPose, color }: { getPose: () => { x: number; y: number; z: number } | null; color: string | null }) {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const p = getPose(), m = mesh.current;
    if (!m) return;
    m.visible = !!p && !!color;
    if (!p || !color) return;
    m.position.set(p.x, p.y + 0.04, p.z);
    m.scale.setScalar(1 + 0.08 * Math.sin(clock.elapsedTime * 2.2));
  });
  return (
    <mesh ref={mesh} rotation={[-Math.PI / 2, 0, 0]} visible={false} renderOrder={4}>
      <ringGeometry args={[0.55, 0.85, 40]} />
      <meshBasicMaterial color={color ?? "#fff"} transparent opacity={0.65} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

export const CHEER_GLYPH = { heart: "\u2764\uFE0F", clap: "\u{1F44F}", fire: "\u{1F525}", wow: "\u2728" } as const;
export type CheerState = { glyph: string; at: number } | null;
export const CHEER_SHOW_S = 2.5;

/** A spectator reaction floating up over the head for CHEER_SHOW_S. */
export function CheerFloat({ getPose, cheer, clock }: { getPose: () => { x: number; y: number; z: number } | null; cheer: { current: CheerState }; clock: () => number }) {
  const sprite = useRef<THREE.Sprite>(null);
  const shown = useRef("");
  const tex = useRef<THREE.CanvasTexture | null>(null);
  useFrame(() => {
    const sp = sprite.current, p = getPose(), c = cheer.current;
    if (!sp) return;
    const age = c ? clock() - c.at : 99;
    sp.visible = !!p && !!c && age >= 0 && age < CHEER_SHOW_S;
    if (!sp.visible || !p || !c) return;
    if (shown.current !== c.glyph) {
      const cv = document.createElement("canvas"); cv.width = cv.height = 128;
      const g = cv.getContext("2d")!; g.font = "96px serif"; g.fillStyle = "#ff4d6d"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(c.glyph, 64, 70);
      tex.current?.dispose(); tex.current = new THREE.CanvasTexture(cv);
      (sp.material as THREE.SpriteMaterial).map = tex.current; (sp.material as THREE.SpriteMaterial).needsUpdate = true;
      shown.current = c.glyph;
    }
    sp.position.set(p.x, p.y + 2.9 + age * 0.5, p.z);
    (sp.material as THREE.SpriteMaterial).opacity = Math.min(1, (CHEER_SHOW_S - age) / 0.6);
  });
  useEffect(() => () => tex.current?.dispose(), []);
  return <sprite ref={sprite} visible={false} scale={[0.9, 0.9, 1]} renderOrder={22}><spriteMaterial transparent depthWrite={false} toneMapped={false} /></sprite>;
}
